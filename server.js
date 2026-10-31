import express from "express";
import cors from "cors";
import { GoogleGenAI } from "@google/genai";

const app = express();
app.set("trust proxy", 1);   // Render sits in front of the server, so this gives each visitor's real address
app.use(cors());
app.use(express.json({ limit: "15mb" }));   // photos make requests bigger
app.use(express.static("public", { dotfiles: "allow" }));   // lets Google read /.well-known/assetlinks.json later

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// If the first model is busy, the server tries the next one
const MODELS = ["gemini-flash-latest", "gemini-flash-lite-latest"];

// ----- Limits, so one person cannot use up your Gemini key -----
// Change these numbers to make the limits stricter or looser
const LIMITS = {
  chat: { perMinute: 12, perDay: 100 },
  report: { perMinute: 5, perDay: 30 },
};
const usage = new Map();   // remembers how much each visitor has used (cleared when the server restarts)

function overLimit(kind, ip) {
  const now = Date.now();
  const key = kind + ":" + ip;
  let u = usage.get(key);
  if (!u) {
    u = { minuteCount: 0, minuteReset: now + 60000, dayCount: 0, dayReset: now + 86400000 };
    usage.set(key, u);
  }
  if (now > u.minuteReset) { u.minuteCount = 0; u.minuteReset = now + 60000; }
  if (now > u.dayReset) { u.dayCount = 0; u.dayReset = now + 86400000; }

  if (u.minuteCount >= LIMITS[kind].perMinute) return "minute";
  if (u.dayCount >= LIMITS[kind].perDay) return "day";
  u.minuteCount++;
  u.dayCount++;
  return null;
}

// tidy up old entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, u] of usage) {
    if (now > u.dayReset) usage.delete(key);
  }
}, 10 * 60 * 1000);

// ----- Reports sent to your phone (using the free ntfy app) -----
// The secret topic name is set in Render -> Environment as NTFY_TOPIC, so it is never in your public code
const NTFY_TOPIC = process.env.NTFY_TOPIC;
// Optional: a token from a free ntfy.sh account.
// With it, your alerts use your own daily allowance instead of one shared with other apps on the same server.
const NTFY_TOKEN = process.env.NTFY_TOKEN;

// ntfy messages can be at most 4096 bytes, so shorten long text safely
function clipBytes(text, maxBytes) {
  let out = text;
  while (Buffer.byteLength(out, "utf8") > maxBytes) {
    out = out.slice(0, Math.floor(out.length * 0.9));
  }
  return out;
}

async function notifyPhone(report) {
  if (!NTFY_TOPIC) return;   // no topic set: reports only go to the logs
  try {
    const message = clipBytes(
      "Question: " + report.question +
        "\n\nReply: " + report.reply +
        "\n\nReason: " + (report.reason || "(none given)"),
      3500
    );
    const response = await fetch("https://ntfy.sh", {
      method: "POST",
      headers: Object.assign(
        { "Content-Type": "application/json" },
        NTFY_TOKEN ? { Authorization: "Bearer " + NTFY_TOKEN } : {}
      ),
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title: "Chatbot report",
        message: message,
        priority: 4,
        tags: ["triangular_flag_on_post"],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      console.log("Phone notification sent to ntfy");
    } else {
      const reason = (await response.text()).slice(0, 200);
      console.error("ntfy refused the notification. Status " + response.status + ": " + reason);
    }
  } catch (error) {
    console.error("Could not send phone notification: " + error.message);
  }
}

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
            systemInstruction:
              "Your name is Orion. If anyone asks your name, say that your name is Orion. " +
              "You are a friendly, helpful assistant. " +
              "If someone sincerely asks what AI model or technology powers you, be honest and say " +
              "you are an AI assistant built on Google's Gemini. Never claim to be a human.",
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

// Turns the page's messages into Gemini's format, including any photos
function toGeminiContents(messages) {
  return messages.map((m) => {
    const parts = [];

    // the page sends a photo as "data:image/jpeg;base64,...."
    if (typeof m.image === "string" && m.image.startsWith("data:image/")) {
      const comma = m.image.indexOf(",");
      const header = m.image.slice(0, comma);                  // data:image/jpeg;base64
      const mimeType = header.slice(5, header.indexOf(";"));   // image/jpeg
      const data = m.image.slice(comma + 1);
      parts.push({ inlineData: { mimeType: mimeType, data: data } });
    }

    const text = (m.content || "").trim();
    parts.push({ text: text || (parts.length ? "Describe this image." : "(empty message)") });

    return { role: m.role === "assistant" ? "model" : "user", parts: parts };
  });
}

app.post("/chat", async (req, res) => {
  const hit = overLimit("chat", req.ip);
  if (hit) {
    return res.status(429).json({
      error: "limit",
      message: hit === "minute"
        ? "You're sending messages too fast. Please wait a minute and try again."
        : "You've reached today's message limit. Please come back tomorrow.",
    });
  }

  try {
    const { messages } = req.body;

    const contents = toGeminiContents(messages);

    const reply = await askGemini(contents);
    res.json({ reply: reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// Users can report an offensive reply. Reports appear in the Render logs, starting with the word REPORT.
app.post("/report", (req, res) => {
  if (overLimit("report", req.ip)) {
    return res.status(429).json({ error: "limit" });
  }
  const clip = (value, max) => String(value || "").slice(0, max);
  const report = {
    time: new Date().toISOString(),
    reason: clip(req.body.reason, 500),
    question: clip(req.body.question, 1000),
    reply: clip(req.body.reply, 3000),
  };
  console.log("REPORT " + JSON.stringify(report));
  notifyPhone(report);   // sends a notification to your phone, without making the user wait
  res.json({ ok: true });
});

// Keep-alive check: an outside pinger opens this every few minutes so Render does not put the app to sleep.
// It does not use Gemini or the visitor limits.
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
  console.log(
    "Phone alerts: " +
      (NTFY_TOPIC
        ? "ON (" + (NTFY_TOKEN ? "signed in to ntfy" : "anonymous") + ")"
        : "OFF (NTFY_TOPIC is not set in Render)")
  );
});
