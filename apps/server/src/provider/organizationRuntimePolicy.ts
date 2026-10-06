/** This VM organization uses manual capacity control. Quota reads are display-only:
 * they populate the Usage view but must not dispatch work behind the owner. Provider
 * failures remain visible, and reset-time continuation stays off. */
export function quotaReadsEnabled(): boolean {
  return true;
}

export function automaticLimitRecoveryEnabled(): boolean {
  return false;
}
