const OpenAI = require("openai");
const knowledge = require("./knowledge.json");

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 10000,
      maxRetries: 1,
    })
  : null;

function askLocalKnowledge(userMessage, tenantKnowledge = knowledge) {
  const message = userMessage.toLowerCase();
  const configuredKnowledge = tenantKnowledge || {};

  if (
    message.includes("orari") ||
    message.includes("aperti") ||
    message.includes("apertura") ||
    message.includes("chiusi") ||
    message.includes("chiusura")
  ) {
    return (
      configuredKnowledge.orari ||
      "Non ho ancora informazioni sugli orari dell'officina."
    );
  }

  if (
    message.includes("prezzo") ||
    message.includes("prezzi") ||
    message.includes("costa") ||
    message.includes("costo") ||
    message.includes("quanto")
  ) {
    return (
      configuredKnowledge.prezzi ||
      "Non ho ancora informazioni sui prezzi dell'officina."
    );
  }

  if (
    message.includes("azienda") ||
    message.includes("chi siete") ||
    message.includes("cosa fate") ||
    message.includes("servizi")
  ) {
    return (
      configuredKnowledge.azienda ||
      "Non ho ancora informazioni configurate sull'officina."
    );
  }

  if (
    message.includes("ciao") ||
    message.includes("buongiorno") ||
    message.includes("buonasera") ||
    message.includes("salve")
  ) {
    return "Ciao! Posso raccogliere una richiesta di assistenza. Scrivi “richiesta officina” per iniziare.";
  }

  return "Posso raccogliere una richiesta di assistenza. Scrivi “richiesta officina” per iniziare; per altre informazioni contatta direttamente l'officina.";
}

function buildContext() {
  return `
Informazioni disponibili:
${Object.values(knowledge).join("\n")}
`;
}

async function askAI(userMessage) {
  if (!client) {
    return askLocalKnowledge(userMessage);
  }

  try {
    const context = buildContext();

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
Sei un assistente aziendale.
Rispondi in italiano semplice, in modo chiaro e sintetico.

Devi usare principalmente queste informazioni:

${context}

Regole:
- Se la risposta è presente nelle informazioni disponibili, rispondi usando quelle informazioni.
- Se la risposta non è presente nelle informazioni disponibili, dillo chiaramente.
- Non inventare prezzi, orari, servizi o dettagli aziendali.
- Se l'utente saluta, rispondi in modo naturale e chiedi come puoi aiutare.
`,
        },
        {
          role: "user",
          content: userMessage,
        },
      ],
    });

    const reply = response.choices[0].message.content;

    return typeof reply === "string" && reply.trim()
      ? reply.trim()
      : askLocalKnowledge(userMessage);
  } catch (err) {
    console.error("Errore OpenAI, uso fallback locale:", err.code || "unknown");

    return askLocalKnowledge(userMessage);
  }
}

module.exports = { askAI, askLocalKnowledge };
