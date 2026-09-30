import Vapi from "@vapi-ai/web";

export const vapi = new Vapi(import.meta.env.VITE_VAPI_PUBLIC_KEY);
export const assistantId = import.meta.env.VITE_VAPI_ASSISTANT_ID as string;
