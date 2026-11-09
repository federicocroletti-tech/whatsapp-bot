# WhatsApp Bot — piattaforma Moto Smart

Backend Node.js/Express per una piattaforma multi-tenant collegata alla WhatsApp
Business Platform tramite una Meta App centrale. Ogni officina ha il proprio
numero WhatsApp Business, credenziali, richieste, configurazione, informativa,
contenuti e branding. Il webhook condiviso instrada gli eventi in base al
`phone_number_id` comunicato da Meta.

Il flusso raccoglie richieste di assistenza con consenso esplicito, non conferma
appuntamenti e non invia promozioni o messaggi avviati dall'azienda.

## Funzioni

- Firma webhook Meta verificata con HMAC-SHA256 e challenge condivisa.
- Routing per `phone_number_id`; un numero non configurato o sospeso non viene
  associato ad alcun tenant.
- Richieste, conversazioni temporanee, deduplicazione, outbox, sessioni e
  cancellazione automatica isolate per tenant.
- Token WhatsApp di ogni officina cifrato nel database con AES-256-GCM; password
  operatore memorizzate con scrypt; sessioni casuali salvate solo tramite hash.
- Provisioning iniziale assistito, protetto da un token amministrativo, con
  primo utente owner, nome legale/visualizzato, palette, logo, informativa,
  dati di knowledge e retention.
- Inbox web raggiungibile da `/operator/:tenantSlug`; il frontend carica
  branding e informativa pubblici e usa sessioni HttpOnly tenant-scoped.
- Invio WhatsApp tramite il token e il numero del tenant, con coda outbox,
  retry e scadenza entro la finestra di assistenza Meta.
- Le risposte WhatsApp usano solo la knowledge locale del tenant: i messaggi
  non vengono inoltrati a OpenAI. L'endpoint dimostrativo separato `/chat` può
  usare OpenAI se `OPENAI_API_KEY` è configurata.

## Configurazione locale

Requisiti: Node.js 22 e PostgreSQL.

```powershell
Copy-Item .env.example .env
npm ci
```

Configura nel file `.env` i valori di test Meta, PostgreSQL, origini frontend e
segreti amministrativi. Genera due segreti indipendenti, ad esempio:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Il primo valore va in `PLATFORM_ADMIN_TOKEN`; il secondo in
`TENANT_CREDENTIAL_ENCRYPTION_KEY` (chiave Base64 da 32 byte). Salvali nel
secret manager del provider e non nel repository o in chat. La perdita o
rotazione della chiave di cifratura richiede di ricifrare i token tenant.

`APP_SECRET` e `VERIFY_TOKEN` appartengono alla Meta App centrale;
`DATABASE_URL` è accessibile solo al backend. In produzione, `WEB_ORIGINS`
deve contenere l'origine HTTPS esatta della inbox (senza path o slash finale).
`ALLOWED_NUMBERS` è solo un filtro opzionale per i test e va lasciato vuoto
quando si ricevono richieste reali.

Applica lo schema e avvia il server:

```powershell
npm run migrate
npm start
```

Il comando di migrazione applica in ordine i file SQL versionati. La migrazione
multi-tenant è additiva: le vecchie tabelle single-tenant vengono lasciate
intatte e non lette dal nuovo codice. Non viene eseguita una migrazione
automatica di richieste legacy perché non è possibile assegnarle con certezza a
un'officina.

## Onboarding iniziale di un'officina

Con la Meta App centrale, l'amministratore collega manualmente la WABA del
cliente e registra il numero tramite l'endpoint amministrativo. Usa un token
server-side di lunga durata con i permessi minimi richiesti dalla WhatsApp
Business Platform e dalla configurazione Meta App; verifica business, accessi
e App Review richiesti da Meta. Il bearer token
amministrativo deve essere inviato soltanto da un client amministrativo
fidato su HTTPS; non chiamare questo endpoint dal browser pubblico. Evita che
reverse proxy, strumenti di monitoraggio o client salvino il corpo della
richiesta, che contiene temporaneamente il token Meta in chiaro.

`POST /platform/tenants` crea in un'unica transazione il tenant e il suo primo
utente owner. Il corpo atteso è:

```json
{
  "slug": "officina-a",
  "legalName": "Officina A S.r.l.",
  "displayName": "Officina A",
  "privacyUrl": "https://officina.example/privacy",
  "requestRetentionDays": 180,
  "branding": {
    "primaryColor": "#123456",
    "accentColor": "#abcdef",
    "logoUrl": "https://officina.example/logo.png"
  },
  "knowledge": {
    "orari": "Lunedì-venerdì 9:00-18:00",
    "prezzi": "I preventivi vengono valutati in officina.",
    "azienda": "Descrizione e servizi dell'officina."
  },
  "waBusinessAccountId": "<id-waba-meta>",
  "waPhoneNumberId": "<id-numero-meta>",
  "waAccessToken": "<segreto-meta>",
  "operator": {
    "username": "responsabile",
    "password": "<password-casuale-di-almeno-16-caratteri>"
  }
}
```

La richiesta deve includere `Authorization: Bearer <PLATFORM_ADMIN_TOKEN>`.
L'API non restituisce il token Meta né la password. Lo slug deve essere
minuscolo, univoco e composto da lettere, numeri e trattini; il numero Meta
deve essere un ID numerico. La retention può essere impostata da 1 a 3650
giorni. Logo e informativa devono usare HTTPS.

Ogni officina deve fornire e verificare la propria informativa privacy prima di
attivare il servizio. La versione iniziale non raccoglie codice fiscale o altri
dati fiscali: andranno richiesti solo quando verrà introdotta la fatturazione.
L'owner iniziale può accedere a `https://<dominio-inbox>/operator/officina-a`.
La gestione di ulteriori account operatore e la modifica self-service delle
impostazioni non sono ancora esposte nell'interfaccia.

## Endpoint

- `GET /health`: verifica la connessione PostgreSQL.
- `GET /webhook` e `POST /webhook`: verifica e ricezione eventi Meta.
- `POST /platform/tenants`: provisioning amministrativo autenticato.
- `GET /public/tenants/:tenantSlug`: nome visualizzato, branding e URL privacy;
  non restituisce credenziali Meta né dati delle richieste.
- `/operator/:tenantSlug/login|session|logout|requests`: autenticazione e inbox
  isolate per tenant.
- `PATCH /operator/:tenantSlug/requests/:id/status`: modifica stato vincolata
  all'ID tenant della sessione.
- `POST /chat`: demo separata, non usata dal webhook WhatsApp.

Configura nella Meta App centrale la callback HTTPS `/webhook`, il
`VERIFY_TOKEN` e il campo `messages`. Meta deve inviare gli eventi dei numeri
registrati alla piattaforma: il backend trova il tenant tramite il
`phone_number_id`, verifica la firma con l'`APP_SECRET` centrale e usa in uscita
il token cifrato associato al tenant. Non usare il token Meta di un cliente per
un altro numero. Le risposte sono riservate alle conversazioni avviate dal
cliente e alla finestra di assistenza Meta; questa implementazione non aggira i
limiti della piattaforma e non invia campagne o messaggi promozionali.

## Dati, privacy e limiti operativi

Le richieste conservano ID WhatsApp, nome, moto, problema, disponibilità,
consenso, stato e data di creazione; vengono cancellate secondo la retention
del tenant. Conversazioni temporanee scadono dopo 24 ore; metadati webhook,
outbox conclusa e sessioni hanno pulizia automatica. La cancellazione viene
eseguita dal worker mentre il servizio è attivo.

Il titolare deve verificare informativa, periodo di conservazione, base
giuridica, procedure per accesso/cancellazione e accordi con i responsabili
prima di usare dati reali. Il testo inviato a `/chat` può essere trasmesso a
OpenAI quando `OPENAI_API_KEY` è configurata; non inoltrare dati personali a
quel percorso senza informativa e valutazione del trattamento.

Il deployment non è configurato da questo repository. Prima di attivare i
clienti, configurare PostgreSQL e segreti nel provider, applicare le
migrazioni, verificare domini e CORS, collaudare callback Meta e verificare i
limiti di conservazione. Il database deve essere raggiungibile solo dal
backend. Non inserire dati reali nei test.

## Test

```powershell
npm test
```
