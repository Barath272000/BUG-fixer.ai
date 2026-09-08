"""
Enums.
Mirrors: backend/prisma/schema.prisma (enum blocks)
"""
import enum


class UserRole(str, enum.Enum):
    USER = "USER"
    ADMIN = "ADMIN"


class SourceType(str, enum.Enum):
    ZIP = "ZIP"
    GITHUB = "GITHUB"
    PASTE = "PASTE"


class ProjectStatus(str, enum.Enum):
    READY = "READY"
    ANALYZING = "ANALYZING"
    FAILED = "FAILED"
    ARCHIVED = "ARCHIVED"


class AnalysisStatus(str, enum.Enum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class PhaseStatus(str, enum.Enum):
    COMPLETED = "COMPLETED"
    RUNNING = "RUNNING"
    PENDING = "PENDING"
    FAILED = "FAILED"


class Severity(str, enum.Enum):
    Critical = "Critical"
    High = "High"
    Medium = "Medium"
    Low = "Low"


class BugStatus(str, enum.Enum):
    Open = "Open"
    InReview = "InReview"
    Fixed = "Fixed"
    Closed = "Closed"
    AISuggested = "AISuggested"
    ApplyingFix = "ApplyingFix"


class AIStatus(str, enum.Enum):
    Pending = "Pending"
    Ready = "Ready"
    Applied = "Applied"


class FixStatus(str, enum.Enum):
    Ready = "Ready"
    Applied = "Applied"
    Superseded = "Superseded"


class ValidationStatus(str, enum.Enum):
    IDLE = "IDLE"
    RUNNING = "RUNNING"
    PASSED = "PASSED"
    FAILED = "FAILED"
    RE_ANALYZING = "RE_ANALYZING"


class ProposalStatus(str, enum.Enum):
    PENDING_PERMISSION = "PENDING_PERMISSION"
    APPROVED_AND_APPLIED = "APPROVED_AND_APPLIED"
    REJECTED = "REJECTED"
    REVERTED = "REVERTED"


class Provider(str, enum.Enum):
    google = "google"
    openrouter = "openrouter"
    groq = "groq"
    openai = "openai"
    anthropic = "anthropic"
    deepseek = "deepseek"
    nvidia = "nvidia"
    custom = "custom"
    github = "github"
