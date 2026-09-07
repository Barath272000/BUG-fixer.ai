"""
Environment configuration.
Mirrors: backend/src/config/env.ts (zod schema -> pydantic-settings)
"""
from functools import lru_cache
from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    NODE_ENV: Literal["development", "test", "production"] = "development"
    PORT: int = Field(default=4000, ge=1, le=65535)
    CORS_ORIGIN: str

    DATABASE_URL: str
    REDIS_URL: str

    JWT_SECRET: str = Field(min_length=32)
    JWT_EXPIRES_IN: str = "1h"
    REFRESH_TOKEN_EXPIRES_IN: str = "30d"

    STORAGE_ROOT: str = "./storage"
    SANDBOX_WORK_ROOT: str = "./sandbox-work"
    MAX_UPLOAD_BYTES: int = 524_288_000
    SANDBOX_TIMEOUT_MS: int = 300_000
    SANDBOX_CPU_LIMIT: float = 2
    SANDBOX_MEMORY_LIMIT: str = "4g"
    SANDBOX_PIDS_LIMIT: int = 256
    SANDBOX_NETWORK_MODE: Literal["none", "bridge"] = "none"

    GITHUB_API_URL: str = "https://api.github.com"
    GITHUB_APP_CLIENT_ID: str | None = None
    GITHUB_APP_CLIENT_SECRET: str | None = None

    OPENAI_API_KEY: str | None = None
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    ANTHROPIC_API_KEY: str | None = None
    ANTHROPIC_BASE_URL: str = "https://api.anthropic.com"
    GOOGLE_API_KEY: str | None = None
    GOOGLE_BASE_URL: str = "https://generativelanguage.googleapis.com/v1beta"
    GROQ_API_KEY: str | None = None
    GROQ_BASE_URL: str = "https://api.groq.com/openai/v1"
    OPENROUTER_API_KEY: str | None = None
    OPENROUTER_BASE_URL: str = "https://openrouter.ai/api/v1"
    DEEPSEEK_API_KEY: str | None = None
    DEEPSEEK_BASE_URL: str = "https://api.deepseek.com/v1"

    DEFAULT_AI_PROVIDER: Literal[
        "openai", "anthropic", "google", "groq", "openrouter", "deepseek"
    ] = "openai"
    DEFAULT_AI_MODEL: str = "gpt-4o-mini"

    ENCRYPTION_KEY: str = Field(min_length=32)
    DEV_SKIP_AUTH: bool = False
    LOG_LEVEL: Literal[
        "fatal", "error", "warn", "info", "debug", "trace", "silent"
    ] = "info"

    @field_validator("DATABASE_URL")
    @classmethod
    def _normalize_db_url(cls, v: str) -> str:
        # SQLAlchemy async needs the asyncpg dialect explicitly.
        if v.startswith("postgresql://"):
            return v.replace("postgresql://", "postgresql+asyncpg://", 1)
        return v


@lru_cache
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]


settings = get_settings()
