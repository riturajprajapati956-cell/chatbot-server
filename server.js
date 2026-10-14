import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// If the first model is busy, the server tries the next one
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function askGemini(contents) {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of MODELS) {
      try {
        const response = await ai.models.generateContent({
          model: model,
          contents: contents,
          config: {
            systemInstruction: "You are a friendly, helpful assistant.",
          },
        });
        return response.text;
      } catch (error) {
        console.error(model + " failed with status " + error.status);
      }
    }
    await wait(2000); // pause 2 seconds, then try again
  }
  throw new Error("All models are busy");
}

app.post("/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const reply = await askGemini(contents);
    res.json({ reply: reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
