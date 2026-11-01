/** Append task-specific SOP to a new user message without changing the stable system prompt. */
export function appendAgentTaskPrompt(prompt: string, taskPrompt: string, isCompactCommand: boolean): string {
  return !isCompactCommand && taskPrompt
    ? `${prompt}\n\n<turn_guidance>\n${taskPrompt}\n</turn_guidance>`
    : prompt
}

/** Keep task guidance ahead of the generic compaction handoff so the instruction survives summarization. */
export function prependPiCompactionTaskGuidance(prompt: string, taskPrompt: string | undefined): string {
  return taskPrompt ? `${taskPrompt}\n\n${prompt}` : prompt
}
