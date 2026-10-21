import "server-only";

export type AIProvider = "gemini" | "mock";

export class AIProviderConfigurationError extends Error {
  constructor(message = 'AI_PROVIDER must be set to either "gemini" or "mock".') {
    super(message);
    this.name = "AIProviderConfigurationError";
  }
}

export function getAIProvider(): AIProvider {
  const provider = process.env.AI_PROVIDER;
  if (provider === "mock") return provider;
  if (provider === "gemini") {
    if (!process.env.GEMINI_API_KEY?.trim()) {
      throw new AIProviderConfigurationError(
        'GEMINI_API_KEY must be configured when AI_PROVIDER is "gemini".'
      );
    }
    return provider;
  }
  throw new AIProviderConfigurationError();
}
