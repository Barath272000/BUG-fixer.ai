"""Mirrors: backend/src/modules/ai/ai.service.ts

Replaces the previous 501 stub. diagnose_bug and copilot_reply now make
real provider calls, using either a user's stored (encrypted) credential
or the server-wide env-configured key/base URL as a fallback, exactly
like the Node version's `credentials()` helper.
"""
import json

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.common.errors.app_error import AppError
from app.core.config import settings
from app.core.secret_crypto import decrypt_secret
from app.models.enums import Provider
from app.models.settings import ProviderCredential
from app.modules.ai.confidence import clamp_confidence
from app.modules.ai.context_builder import build_ai_context
from app.modules.ai.model_router import resolve_model
from app.modules.ai.prompt_builder import build_copilot_prompt, build_diagnosis_prompt
from app.modules.ai.providers.anthropic_provider import AnthropicProvider
from app.modules.ai.providers.base import AIProvider, ChatRequest, ProviderChatError
from app.modules.ai.providers.google_provider import GoogleProvider
from app.modules.ai.providers.openai_compatible_provider import OpenAICompatibleProvider
from app.modules.ai.providers.openai_provider import OpenAIProvider
from app.modules.ai.usage_tracking import record_rate_limit

_ENV_KEY_MAP = {
    "openai": lambda: settings.OPENAI_API_KEY,
    "anthropic": lambda: settings.ANTHROPIC_API_KEY,
    "google": lambda: settings.GOOGLE_API_KEY,
    "groq": lambda: settings.GROQ_API_KEY,
    "openrouter": lambda: settings.OPENROUTER_API_KEY,
    "deepseek": lambda: settings.DEEPSEEK_API_KEY,
    "nvidia": lambda: settings.NVIDIA_API_KEY,
}
_ENV_URL_MAP = {
    "openai": lambda: settings.OPENAI_BASE_URL,
    "anthropic": lambda: settings.ANTHROPIC_BASE_URL,
    "google": lambda: settings.GOOGLE_BASE_URL,
    "groq": lambda: settings.GROQ_BASE_URL,
    "openrouter": lambda: settings.OPENROUTER_BASE_URL,
    "deepseek": lambda: settings.DEEPSEEK_BASE_URL,
    "nvidia": lambda: settings.NVIDIA_BASE_URL,
}


def _provider_for(provider: str) -> AIProvider:
    if provider == "openai":
        return OpenAIProvider()
    if provider == "anthropic":
        return AnthropicProvider()
    if provider == "google":
        return GoogleProvider()
    if provider in ("groq", "openrouter", "deepseek", "nvidia"):
        return OpenAICompatibleProvider(provider)
    raise AppError(400, "UNSUPPORTED_PROVIDER", "The requested AI provider is not supported")


async def _credentials(db: AsyncSession, user_id: str, provider: str) -> dict:
    try:
        provider_enum = Provider(provider)
    except ValueError:
        raise AppError(400, "UNSUPPORTED_PROVIDER", "The requested AI provider is not supported")

    stmt = select(ProviderCredential).where(
        ProviderCredential.userId == user_id, ProviderCredential.provider == provider_enum
    )
    record = (await db.execute(stmt)).scalar_one_or_none()
    url_fn = _ENV_URL_MAP.get(provider)
    if record:
        # A saved credential may not have a custom base URL (the "bring your
        # own key" flow doesn't ask for one) — fall back to the provider's
        # default base URL rather than passing None into the HTTP request.
        return {
            "key": decrypt_secret(record.encryptedKey),
            "base_url": record.baseUrl or (url_fn() if url_fn else None),
        }

    key_fn = _ENV_KEY_MAP.get(provider)
    return {
        "key": key_fn() if key_fn else None,
        "base_url": url_fn() if url_fn else None,
    }

def _parse_json(text: str) -> dict:
    clean = text.strip()
    if clean.startswith("```"):
        clean = clean.split("\n", 1)[-1] if "\n" in clean else clean
        clean = clean.removeprefix("json\n").removeprefix("json")
    clean = clean.strip().removeprefix("```json").removesuffix("```").strip()
    try:
        return json.loads(clean)
    except json.JSONDecodeError:
        start = clean.find("{")
        end = clean.rfind("}")
        if start >= 0 and end > start:
            try:
                return json.loads(clean[start : end + 1])
            except json.JSONDecodeError:
                pass
        raise ValueError(
            "The AI model's reply wasn't valid JSON, so it couldn't be parsed. "
            "This can happen with reasoning models on complex files — try again, "
            "or switch to a non-reasoning model for this task."
        )


async def diagnose_bug(
    db: AsyncSession,
    user_id: str,
    project_id: str,
    bug_id: str,
    provider: str | None = None,
    model: str | None = None,
) -> dict:
    resolved = await resolve_model(db, provider, model, user_id)
    creds = await _credentials(db, user_id, resolved.provider)
    context = await build_ai_context(db, project_id, bug_id=bug_id)

    chat_request = ChatRequest(
        model=resolved.model,
        system="You are a senior debugging engineer.",
        user=build_diagnosis_prompt(context),
        api_key=creds["key"],
        base_url=creds["base_url"],
    )
    try:
        chat_result = await _provider_for(resolved.provider).chat(chat_request)
    except ProviderChatError as exc:
        # A 429 reports remaining=0 in its headers - record that real usage
        # data even though the call itself failed, then let it propagate.
        if exc.rate_limit:
            await record_rate_limit(user_id, resolved.provider, resolved.model, exc.rate_limit)
        raise

    if chat_result.rate_limit:
        await record_rate_limit(user_id, resolved.provider, resolved.model, chat_result.rate_limit)

    result = _parse_json(chat_result.text)

    return {
        "provider": resolved.provider,
        "model": resolved.model,
        "confidence": clamp_confidence(float(result.get("confidence", 0) or 0)),
        "explanation": str(result.get("explanation", "")),
        "patchSummary": str(result.get("patchSummary", "")),
        "affectedFiles": [str(f) for f in (result.get("affectedFiles") or [])],
        "estimatedMinutes": max(1, int(result.get("estimatedMinutes", 15) or 15)),
        "originalCode": str(result.get("originalCode", "")),
        "proposedCode": str(result.get("proposedCode", "")),
        "unifiedDiff": str(result.get("unifiedDiff", "")),
    }


async def copilot_reply(
    db: AsyncSession,
    user_id: str,
    project_id: str | None,
    user_message: str,
    provider: str | None = None,
    model: str | None = None,
    file_path: str | None = None,
) -> dict:
    resolved = await resolve_model(db, provider, model, user_id)
    creds = await _credentials(db, user_id, resolved.provider)
    context = await build_ai_context(db, project_id, user_id=user_id, file_path=file_path, question=user_message) if project_id else "{}"

    chat_request = ChatRequest(
        model=resolved.model,
        system="You are a repository-aware coding copilot.",
        user=build_copilot_prompt(context, user_message),
        api_key=creds["key"],
        base_url=creds["base_url"],
    )
    try:
        chat_result = await _provider_for(resolved.provider).chat(chat_request)
        if chat_result.rate_limit:
            await record_rate_limit(user_id, resolved.provider, resolved.model, chat_result.rate_limit)
        result = _parse_json(chat_result.text)
    except ProviderChatError as exc:
        if exc.rate_limit:
            await record_rate_limit(user_id, resolved.provider, resolved.model, exc.rate_limit)
        raise AppError(502, "AI_PROVIDER_ERROR", str(exc)) from exc
    except ValueError as exc:
        raise AppError(502, "AI_PROVIDER_ERROR", str(exc)) from exc
    return {"provider": resolved.provider, "model": resolved.model, "result": result}