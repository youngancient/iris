// Masking for anything written to logs (design §9 PII).

const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

/** amara@lagosledger.example → a***@lagosledger.example */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, "$1***@$2");
}

/** Deep copy with every email in every string masked. */
export function maskDeep<T>(value: T): T {
  if (typeof value === "string") return maskEmails(value) as T;
  if (Array.isArray(value)) return value.map(maskDeep) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, maskDeep(v)])) as T;
  }
  return value;
}
