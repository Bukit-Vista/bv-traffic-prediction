import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        ink: "#172026",
        muted: "#5f6b73",
        panel: "#f7f9fb",
        line: "#d8e0e6",
        positive: "#177245",
        warning: "#a26b00",
        danger: "#b9382f"
      }
    }
  },
  plugins: []
};

export default config;
