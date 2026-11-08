# WhatsApp Bot — Moto Smart intake prototype

Backend Node.js/Express per un flusso WhatsApp Business Platform che raccoglie
richieste di assistenza motocicli. Non conferma appuntamenti, non invia
promozioni e non contatta utenti che non hanno avviato la conversazione.

## Funzioni

- Webhook Meta con verifica HMAC-SHA256 della firma e deduplicazione degli ID
  messaggio.
- Raccolta guidata e con consenso di nome, moto, problema e disponibilità.
- Richieste e stato della conversazione conservati in PostgreSQL.
- Coda outbox con retry per le risposte WhatsApp; gli invii sono risposte a
  conversazioni avviate dal cliente e soggetti alla finestra di assistenza Meta.
- Le risposte ai webhook WhatsApp usano solo la knowledge locale: i messaggi
  WhatsApp non vengono inoltrati a OpenAI. Senza dati officina configurati il
  bot non inventa orari o prezzi. L'endpoint separato `/chat` può usare OpenAI
  se `OPENAI_API_KEY` è configurata.
- Le richieste vengono cancellate dopo 30 giorni per impostazione predefinita
  (`REQUEST_RETENTION_DAYS`); conversazioni temporanee scadono dopo 24 ore e
  metadati di webhook/coda dopo 30 giorni.
- I contenuti dei messaggi e le risposte AI non vengono scritti nei log
  applicativi.
- `ALLOWED_NUMBERS` può limitare i mittenti in test; se impostato, tutti gli
  altri vengono ignorati. In produzione, ometterlo per ricevere richieste
  iniziate dai clienti.

La fase MVP salva le pratiche ma non implementa una inbox operatore o avvisi
all'officina. Il testo “richiesta ricevuta” non equivale a conferma o
accettazione dell'intervento.

## Configurazione locale

Requisiti: Node.js 22 e PostgreSQL.

```powershell
Copy-Item .env.example .env
npm ci
```

Configura nel `.env` valori di test Meta e un database PostgreSQL locale.
`APP_SECRET`, `TOKEN`, `PHONE_NUMBER_ID`, `VERIFY_TOKEN`, `DATABASE_URL`,
`WORKSHOP_NAME` e `PRIVACY_URL` sono necessari per avviare il server. Non
committare mai `.env` o credenziali reali. Per testare il flusso senza Meta o
database, esegui `npm test`.

Applica esplicitamente lo schema prima di avviare il server:

```powershell
npm run migrate
npm start
```

`GET /health` controlla la connessione PostgreSQL. Il webhook Meta usa
`GET /webhook` per la verifica e `POST /webhook` per gli eventi.

## Dati e privacy

Le pratiche conservano identificativo WhatsApp, nome, moto, problema,
disponibilità, data del consenso, stato e data di creazione. L'MVP cancella
automaticamente le pratiche dopo 30 giorni (configurabile tra 1 e 3650 giorni).
Le conversazioni temporanee scadono dopo 24 ore; gli ID webhook e i record
terminali della coda di invio dopo 30 giorni. La cancellazione avviene tramite
il worker e quindi richiede che il servizio sia attivo.

Il titolare deve verificare il periodo scelto, completare una reale informativa
privacy indicata da `PRIVACY_URL` e definire una procedura per richieste di
accesso o cancellazione prima di usare dati reali. L'endpoint separato `/chat`
può trasmettere il testo inviato a OpenAI quando `OPENAI_API_KEY` è configurata;
non esporlo a dati personali senza informativa e valutazione del trattamento.

Non inserire nei test dati reali di clienti. Usare un database separato e
credenziali di sviluppo. PostgreSQL deve essere raggiungibile solo dal backend;
non esporre `DATABASE_URL` o token nel frontend.

## Deploy e attivazione Meta

Prima di attivare il webhook:

1. provisionare PostgreSQL e configurare le variabili d'ambiente del backend;
2. impostare `PRIVACY_URL` su un'informativa effettiva e `WORKSHOP_NAME` sul
   nome corretto dell'officina;
3. eseguire `npm run migrate` con `DATABASE_URL`;
4. verificare in Meta App Dashboard la callback HTTPS e i campi webhook
   `messages`, configurando il verify token e app secret;
5. configurare `TOKEN`, `PHONE_NUMBER_ID` e una versione Graph API supportata
   dalla propria app.

Il repository non include un `DATABASE_URL`, token Meta o configurazione di
deploy. Le credenziali e l'informativa devono essere configurate fuori dal
repository. L'uso di dati personali reali richiede una verifica privacy e
operativa prima dell'attivazione.

## Test

```powershell
npm test
```
