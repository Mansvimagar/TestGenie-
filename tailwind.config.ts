import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "#020617",
        card: "#0f172a",
        border: "#1e293b",
        primary: {
          DEFAULT: "#4f46e5",
          hover: "#4338ca",
        },
        success: "#059669",
        danger: "#dc2626",
      },
    },
  },
  plugins: [],
};

export default config;
