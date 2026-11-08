const INITIAL_CONVERSATION = Object.freeze({
  step: "idle",
  customer_name: null,
  motorcycle: null,
  issue: null,
  availability: null,
  consent_at: null,
});

const STEP_PROMPTS = Object.freeze({
  name: "Come ti chiami? Scrivi nome e cognome.",
  motorcycle: "Qual è la moto? Indica marca, modello e, se possibile, anno.",
  issue: "Descrivi il problema o il lavoro richiesto (massimo 500 caratteri).",
  availability: "In quali giorni o orari preferisci essere ricontattato?",
});

function normalizeText(text) {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleLowerCase("it");
}

function isIntakeIntent(text) {
  const normalized = normalizeText(text);
  return /\b(tagliando|riparazione|preventivo|guasto|assistenza|intervento|manutenzione|revisione|appuntamento|officina)\b/.test(
    normalized,
  );
}

function transitionConversation(conversation, text, { workshopName, privacyUrl, now = new Date() }) {
  const normalized = normalizeText(text);

  if (/^(annulla|annullare|cancel|stop)$/.test(normalized)) {
    return {
      conversation: { ...INITIAL_CONVERSATION },
      reply: "Va bene, ho annullato la richiesta in corso. Se ti serve, puoi iniziarne un'altra scrivendo “richiesta officina”.",
    };
  }

  if (conversation.step === "idle") {
    if (!isIntakeIntent(text)) return null;

    const policyNotice = privacyUrl ? `\nInformativa privacy: ${privacyUrl}` : "";
    return {
      conversation: { ...INITIAL_CONVERSATION, step: "consent" },
      reply: `Ciao, sono l'assistente automatico di ${workshopName}. Posso raccogliere i dati necessari per una richiesta di assistenza e per ricontattarti su questa richiesta. Non verrà confermato automaticamente alcun appuntamento.${policyNotice}\nSe acconsenti, rispondi SÌ. Altrimenti scrivi ANNULLA.`,
    };
  }

  if (conversation.step === "consent") {
    if (/^(si|sì|ok|acconsento)$/.test(normalized)) {
      return {
        conversation: {
          ...INITIAL_CONVERSATION,
          step: "name",
          consent_at: now.toISOString(),
        },
        reply: STEP_PROMPTS.name,
      };
    }

    return {
      conversation: { ...INITIAL_CONVERSATION },
      reply: "Non ho registrato la richiesta. Se vuoi procedere in seguito, scrivi “richiesta officina”.",
    };
  }

  const prompts = {
    name: { field: "customer_name", min: 2, max: 80 },
    motorcycle: { field: "motorcycle", min: 2, max: 120 },
    issue: { field: "issue", min: 8, max: 500 },
    availability: { field: "availability", min: 2, max: 160 },
  };
  const current = prompts[conversation.step];

  if (!current) {
    throw new Error(`Passaggio conversazione non supportato: ${conversation.step}`);
  }

  const value = text.trim();
  if (value.length < current.min || value.length > current.max) {
    return {
      conversation,
      reply: `La risposta deve avere da ${current.min} a ${current.max} caratteri. ${STEP_PROMPTS[conversation.step]}`,
    };
  }

  const updated = { ...conversation, [current.field]: value };
  const nextSteps = {
    name: "motorcycle",
    motorcycle: "issue",
    issue: "availability",
  };
  const nextStep = nextSteps[conversation.step];

  if (nextStep) {
    updated.step = nextStep;
    return { conversation: updated, reply: STEP_PROMPTS[nextStep] };
  }

  const request = {
    customer_name: updated.customer_name,
    motorcycle: updated.motorcycle,
    issue: updated.issue,
    availability: updated.availability,
    consent_at: updated.consent_at,
  };

  return {
    conversation: { ...INITIAL_CONVERSATION },
    request,
    reply: "Grazie, ho ricevuto la tua richiesta. L'officina la valuterà e ti ricontatterà; questo messaggio non conferma un appuntamento.",
  };
}

module.exports = { INITIAL_CONVERSATION, isIntakeIntent, transitionConversation };
