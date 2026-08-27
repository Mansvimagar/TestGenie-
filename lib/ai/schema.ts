import { Type, type Schema } from "@google/genai";

// JSON schema handed to Gemini for structured output. Keep in sync with
// lib/validation/schemas.ts (questionSchema), which re-validates the result
// server-side -- the model's output is never trusted blindly.
export const GEMINI_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          topic: { type: Type.STRING },
          question: { type: Type.STRING },
          options: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            minItems: "4",
            maxItems: "4",
          },
          correctAnswerIndex: { type: Type.INTEGER, minimum: 0, maximum: 3 },
        },
        required: ["topic", "question", "options", "correctAnswerIndex"],
      },
    },
  },
  required: ["questions"],
};
