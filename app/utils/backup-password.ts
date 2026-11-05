export function validateBackupPassword(
  password: string,
  confirmation?: string,
) {
  if (!password) return "empty";
  if (confirmation !== undefined && password !== confirmation)
    return "mismatch";
  return undefined;
}
