// Prices used for figures the providers don't report per call. Claude's cost comes from
// the Agent SDK per turn, and Vapi's from its end-of-call report, so only embeddings are
// estimated here. One place to edit when a price changes (design §15).
export const VOYAGE_USD_PER_MILLION_TOKENS = 0.02; // voyage-4-lite
export const EST_TOKENS_PER_QUERY = 20; // a short spoken question
