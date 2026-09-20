export function automaticApproval({
  securityDecision,
  requiresUserConfirmation,
  riskLevel,
  requested = false,
  tool,
  allowedTools = [],
}) {
  const approved =
    requested &&
    allowedTools.includes(tool) &&
    securityDecision === 'clear' &&
    requiresUserConfirmation === false &&
    riskLevel <= 1
  return {
    auto_approved: approved,
    reason: approved
      ? 'explicitly_scoped_clear_low_risk'
      : 'not_explicitly_scoped_or_review_required',
  }
}
