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

// ----- Reports sent to your Gmail (using the free Resend email service) -----
// Both values are set in Render -> Environment, so they are never in your public code:
//   RESEND_API_KEY  = the key from your Resend account
//   REPORT_EMAIL_TO = your Gmail address (the same one you signed up to Resend with)
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_EMAIL_TO = process.env.REPORT_EMAIL_TO;

// Kept with the same name so the /report route below does not need to change.
async function notifyPhone(report) {
  if (!RESEND_API_KEY || !REPORT_EMAIL_TO) return;   // not set: reports only go to the logs
  try {
    const text =
      "Question: " + report.question +
      "\n\nReply: " + report.reply +
      "\n\nReason: " + (report.reason || "(none given)") +
      "\n\nTime: " + report.time;
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + RESEND_API_KEY,
      },
      body: JSON.stringify({
        from: "Orion Reports <onboarding@resend.dev>",
        to: [REPORT_EMAIL_TO],
        subject: "Orion report",
        text: text,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      console.log("Report email sent via Resend");
    } else {
      const reason = (await response.text()).slice(0, 200);
      console.error("Resend refused the email. Status " + response.status + ": " + reason);
    }
  } catch (error) {
    console.error("Could not send report email: " + error.message);
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ----- Coding mode: extra instructions added only when the chat's switch is on Coding -----
// Normal mode sends nothing extra, so Orion behaves exactly as before.
const CODING_EXTRA =
  " The person has switched on Coding mode, so help like a careful programming assistant. " +
  "Put all code inside fenced code blocks and always name the language right after the opening fence (for example ```python). " +
  "When the code is short enough, give complete working code instead of fragments. " +
  "Keep the explanation brief and clear. " +
  "If an important detail is missing (the language, the framework, or what the code should do), ask one short question instead of guessing.";

function codingExtra(mode) {
  return mode === "coding" ? CODING_EXTRA : "";   // anything else counts as Normal
}

async function askGemini(contents, extra = "") {
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
              "you are an AI assistant built on Google's Gemini. Never claim to be a human." +
              extra,
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
    const { messages, mode } = req.body;

    const contents = toGeminiContents(messages);

    const reply = await askGemini(contents, codingExtra(mode));
    res.json({ reply: reply });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Something went wrong" });
  }
});

// ----- Streaming reply (new): /chat-stream sends the answer in small pieces as Gemini writes it -----
// The normal /chat route above is unchanged and still works as before.
// Same instruction text as in askGemini, so Orion behaves the same in both routes.
const SYSTEM_PROMPT =
  "Your name is Orion. If anyone asks your name, say that your name is Orion. " +
  "You are a friendly, helpful assistant. " +
  "If someone sincerely asks what AI model or technology powers you, be honest and say " +
  "you are an AI assistant built on Google's Gemini. Never claim to be a human.";

// The reply always ends with one of these two markers, so the page can tell
// a finished reply from one that was cut off halfway.
const STREAM_DONE = "\u0000DONE";
const STREAM_FAIL = "\u0000ERROR";

// Text of one piece (never throws, and never contains the marker character)
function pieceText(chunk) {
  try {
    return (chunk.text || "").replace(/\u0000/g, "");
  } catch (error) {
    return "";
  }
}

// Same retry idea as askGemini: if a model is busy, try the next one.
// This only happens BEFORE the first piece is sent, so the user never sees a half-and-half reply.
async function openGeminiStream(contents, extra = "") {
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const model of MODELS) {
      try {
        const stream = await ai.models.generateContentStream({
          model: model,
          contents: contents,
          config: { systemInstruction: SYSTEM_PROMPT + extra },
        });
        const iterator = stream[Symbol.asyncIterator]();
        while (true) {
          const step = await iterator.next();
          if (step.done) break;
          const piece = pieceText(step.value);
          if (piece) return { iterator: iterator, first: piece };
        }
        console.error(model + " gave an empty reply");
      } catch (error) {
        console.error(model + " failed with status " + error.status);
      }
    }
    await wait(2000); // pause 2 seconds, then try again
  }
  throw new Error("All models are busy");
}

app.post("/chat-stream", async (req, res) => {
  const hit = overLimit("chat", req.ip);   // same visitor limits as /chat
  if (hit) {
    return res.status(429).json({
      error: "limit",
      message: hit === "minute"
        ? "You're sending messages too fast. Please wait a minute and try again."
        : "You've reached today's message limit. Please come back tomorrow.",
    });
  }

  // If the visitor closes the app mid-reply, stop asking Gemini for more
  let clientGone = false;
  res.on("close", () => {
    if (!res.writableFinished) clientGone = true;
  });

  try {
    const { messages, mode } = req.body;
    const contents = toGeminiContents(messages);

    const { iterator, first } = await openGeminiStream(contents, codingExtra(mode));
    if (clientGone) {
      try { await iterator.return(); } catch (e) {}
      return;
    }

    // From here on the reply has started, so we can no longer send an error page
    res.status(200);
    res.set({
      "Content-Type": "text/event-stream; charset=utf-8",   // this type is not held back by proxies
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    res.write(first);

    try {
      while (!clientGone) {
        const step = await iterator.next();
        if (step.done) break;
        const piece = pieceText(step.value);
        if (piece) res.write(piece);
      }
      if (clientGone) {
        try { await iterator.return(); } catch (e) {}
      } else {
        res.end(STREAM_DONE);
      }
    } catch (error) {
      console.error("Stream broke: " + error.message);
      if (!clientGone) res.end(STREAM_FAIL);
    }
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Something went wrong" });
    } else {
      res.end(STREAM_FAIL);
    }
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
  notifyPhone(report);   // sends the report to your Gmail, without making the user wait
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
    "Report emails: " +
      (RESEND_API_KEY && REPORT_EMAIL_TO
        ? "ON"
        : "OFF (RESEND_API_KEY or REPORT_EMAIL_TO is not set in Render)")
  );
});
