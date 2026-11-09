function createOperatorHandlers({ pool }) {
  async function listRequests(req, res) {
    const status = req.query.status || "all";
    if (!["all", "received", "in_review", "closed"].includes(status)) {
      return res.status(400).json({ error: "Filtro stato non valido" });
    }

    const result = await pool.query(
      `SELECT id, wa_id, customer_name, motorcycle, issue, availability,
              status, created_at
       FROM tenant_moto_service_requests
       WHERE tenant_id = $1 AND ($2 = 'all' OR status = $2)
       ORDER BY created_at DESC, id DESC
       LIMIT 100`,
      [req.operatorTenantId, status],
    );
    return res.status(200).json({ requests: result.rows });
  }

  async function updateRequestStatus(req, res) {
    const { id } = req.params;
    const { status } = req.body ?? {};
    if (!/^[1-9]\d{0,18}$/.test(id)) {
      return res
        .status(400)
        .json({ error: "Identificativo richiesta non valido" });
    }
    if (!["received", "in_review", "closed"].includes(status)) {
      return res.status(400).json({ error: "Stato non valido" });
    }

    const result = await pool.query(
      `      UPDATE tenant_moto_service_requests
      SET status = $3
      WHERE id = $1 AND tenant_id = $2
       RETURNING id, wa_id, customer_name, motorcycle, issue, availability,
                 status, created_at`,
      [id, req.operatorTenantId, status],
    );
    if (result.rowCount === 0) {
      return res.sendStatus(404);
    }
    return res.status(200).json({ request: result.rows[0] });
  }

  return { listRequests, updateRequestStatus };
}

module.exports = { createOperatorHandlers };
