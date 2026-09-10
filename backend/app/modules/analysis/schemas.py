"""Mirrors: backend/src/modules/analysis/analysis.controller.ts"""
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class PhaseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    number: int
    name: str
    description: str
    status: str
    durationMs: int | None
    validationStatus: str
    startedAt: datetime | None
    completedAt: datetime | None
    subprocesses: list[dict] | None = None
    validationReport: dict | None = None


class AnalysisRunOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    projectId: str
    status: str
    requestedBy: str
    startedAt: datetime | None
    completedAt: datetime | None
    errorMessage: str | None
    createdAt: datetime
    updatedAt: datetime


class AnalysisRunDetailOut(AnalysisRunOut):
    phases: list[PhaseOut] = []


class RecentAnalysisItem(BaseModel):
    id: str
    projectId: str
    projectName: str
    status: str
    startedAt: datetime | None
    completedAt: datetime | None
    createdAt: datetime
    durationMs: int | None
    bugsFound: int
    bugsFixed: int


class RecentAnalysisStats(BaseModel):
    totalRuns: int
    fixed: int
    failed: int


class RecentAnalysisResponse(BaseModel):
    items: list[RecentAnalysisItem]
    stats: RecentAnalysisStats


class PipelineLogOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    phaseId: str | None
    timestamp: datetime
    level: str
    category: str
    message: str
