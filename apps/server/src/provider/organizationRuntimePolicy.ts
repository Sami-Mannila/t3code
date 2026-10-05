/** This VM organization uses manual capacity control. Provider failures remain visible;
 * quota polling and reset-time continuation must not dispatch work behind the owner. */
export function quotaReadsEnabled(): boolean {
  return false;
}

export function automaticLimitRecoveryEnabled(): boolean {
  return false;
}
