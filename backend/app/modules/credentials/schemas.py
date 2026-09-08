"""New module — no Node/TS counterpart.

Backs the "AI Engine & Model Management" modal's per-provider API key flow:
save a key -> validate it against the provider's real /models endpoint ->
return the live list of models, split into free / paid.
"""
from pydantic import BaseModel


class ModelInfo(BaseModel):
    id: str
    name: str
    free: bool
    # Human-readable pricing, e.g. "$0.15 / 1M in Ā· $0.60 / 1M out". None when
    # the provider doesn't expose per-model pricing in its models endpoint.
    pricing: str | None = None


class CredentialStatus(BaseModel):
    provider: str
    hasKey: bool
    # True when no user key is saved but the server-wide .env already has one
    # for this provider (e.g. GROQ_API_KEY), so models can load without a key.
    envFallback: bool
    baseUrl: str | None = None


class SaveCredentialRequest(BaseModel):
    provider: str
    apiKey: str
    baseUrl: str | None = None


class SaveCredentialResponse(BaseModel):
    provider: str
    models: list[ModelInfo]


class ModelsResponse(BaseModel):
    provider: str
    configured: bool
    models: list[ModelInfo]
