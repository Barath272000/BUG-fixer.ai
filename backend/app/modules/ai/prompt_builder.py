"""Mirrors: backend/src/modules/ai/prompt-builder.ts"""


def build_diagnosis_prompt(context: str) -> str:
    return (
        "You are a senior debugging engineer. Analyze the supplied project context. "
        "Respond with ONLY a single valid JSON object — no markdown fences, no reasoning "
        "text, no commentary before or after it. Escape every double quote, backslash, and "
        "newline that appears inside string values so the JSON stays valid. "
        "Return valid JSON with keys rootCause, explanation, confidence, patchSummary, "
        "affectedFiles, estimatedMinutes, originalCode, proposedCode, unifiedDiff. "
        "Do not claim tests passed unless test evidence is provided.\n\n"
        f"CONTEXT:\n{context}"
    )


def build_copilot_prompt(context: str, user_message: str) -> str:
    return (
        "You are a repository-aware coding copilot. Answer the user and propose changes "
        "only when evidence in the context supports them. "
        "Respond with ONLY a single valid JSON object — no markdown fences, no reasoning "
        "text, no commentary before or after it. Escape every double quote, backslash, and "
        "newline that appears inside string values so the JSON stays valid. "
        "Return JSON with keys answer, proposal. Proposal must be null or contain "
        "file,title,description,explanation,startLine,endLine,originalCode,proposedCode,diffSummary.\n\n"
        f"PROJECT CONTEXT:\n{context}\n\nUSER:\n{user_message}"
    )