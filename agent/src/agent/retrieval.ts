// TODO: search_knowledge_base tool
//  1. embed the query with Voyage (voyage-3-lite)
//  2. call supabase.rpc("match_kb_chunks", { query_embedding, match_count: 4 })
//  3. insert a retrieval_logs row (query, chunk ids, titles, summary)
//  4. return chunk text to the agent
// Expose it via createSdkMcpServer() from the Agent SDK as an in-process MCP server.
export {};
