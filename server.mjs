// Ponte mTLS ANTT PEF / CIOT — Node puro, sem dependências.
// Publica em Render free (ou qualquer host Node 18+).
//
// Variáveis de ambiente:
//   PORT          porta (o Render injeta automaticamente)
//   BRIDGE_TOKEN  segredo compartilhado; se definido, exige header x-bridge-token
//
// Endpoints:
//   GET  /health                -> { ok: true }
//   POST /emitir                -> { servico, ambiente, pfxBase64, senha, payload }
//   POST /situacao              -> { ambiente, pfxBase64, senha, payload }

import https from "node:https";
import http from "node:http";

const HOSTS = {
  prod: "appservices.antt.gov.br",
  homolog: "appservices-hml.antt.gov.br",
};

const SERVICOS = new Set([
  "DeclaracaoOperacaoTransporte",
  "ConsultarCIOTGerado",
  "ConsultarFrotaTransportador",
  "ConsultarSituacaoTransportador",
  "RetificacaoOperacaoTransporte",
  "EncerramentoOperacaoTransporte",
  "CancelamentoOperacaoTransporte",
]);

function chamarAntt({ servico, ambiente, pfxBase64, senha, payload }) {
  if (!SERVICOS.has(servico)) throw new Error(`Serviço inválido: ${servico}`);
  const hostname = HOSTS[ambiente] ?? HOSTS.homolog;
  const corpo = JSON.stringify(payload ?? {});
  const opcoes = {
    hostname,
    port: 443,
    path: `/pefServices/api/${servico}`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(corpo),
      Accept: "application/json",
    },
    timeout: 45000,
    pfx: Buffer.from(String(pfxBase64).replace(/\s+/g, ""), "base64"),
    passphrase: senha ?? "",
  };

  return new Promise((resolve, reject) => {
    const req = https.request(opcoes, (res) => {
      let dados = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (dados += c));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(dados);
        } catch (_) {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, dados: json, bruto: dados.slice(0, 4000) });
      });
    });
    req.on("timeout", () => req.destroy(new Error("Tempo esgotado ao falar com a ANTT")));
    req.on("error", reject);
    req.write(corpo);
    req.end();
  });
}

function json(res, status, obj) {
  const corpo = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(corpo),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type, x-bridge-token",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  });
  res.end(corpo);
}

const servidor = http.createServer((req, res) => {
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && req.url.startsWith("/health")) return json(res, 200, { ok: true });

  if (req.method !== "POST") return json(res, 405, { ok: false, erro: "Use POST." });

  const token = process.env.BRIDGE_TOKEN;
  if (token && req.headers["x-bridge-token"] !== token) {
    return json(res, 401, { ok: false, erro: "TOKEN_INVALIDO" });
  }

  let cru = "";
  req.on("data", (c) => {
    cru += c;
    if (cru.length > 3_000_000) req.destroy();
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(cru || "{}");
    } catch (_) {
      return json(res, 400, { ok: false, erro: "JSON inválido" });
    }
    if (!body.pfxBase64) return json(res, 400, { ok: false, erro: "CERTIFICADO_AUSENTE" });

    const servico =
      req.url.startsWith("/situacao") ? "ConsultarSituacaoTransportador" : body.servico ?? "DeclaracaoOperacaoTransporte";

    try {
      const r = await chamarAntt({ ...body, servico });
      return json(res, r.status === 200 ? 200 : r.status || 502, {
        ok: r.status === 200,
        antt_status: r.status,
        antt: r.dados,
        bruto: r.dados ? undefined : r.bruto,
      });
    } catch (e) {
      return json(res, 502, { ok: false, erro: String(e?.message ?? e) });
    }
  });
});

const porta = Number(process.env.PORT ?? 3000);
servidor.listen(porta, () => console.log(`Ponte ANTT ouvindo na porta ${porta}`));
