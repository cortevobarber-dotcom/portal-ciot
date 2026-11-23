// Ponte mTLS ANTT PEF / CIOT — Node puro, sem dependências.
// Publica em Render free (ou qualquer host Node 18+).
//
// Variáveis de ambiente:
//   PORT          porta (o Render injeta automaticamente)
//   BRIDGE_TOKEN  segredo compartilhado; se definido, exige header x-bridge-token
//
// Endpoints:
//   GET  /health     -> { ok: true }
//   POST /testar     -> { ok: true, ponte: "no ar" }
//   POST /emitir     -> { action?, servico?, ambiente?, pfxBase64, senha, payload }
//   POST /situacao   -> { ambiente, pfxBase64, senha, payload }
//
// Aceita tanto chamadas por rota quanto por "action" no corpo, e apelidos
// comuns de campo (certificado, certificadoBase64, pfx_base64, password...).

import https from "node:https";
import http from "node:http";

const HOSTS = {
  prod: "appservices.antt.gov.br",
  producao: "appservices.antt.gov.br",
  homolog: "appservices-hml.antt.gov.br",
  homologacao: "appservices-hml.antt.gov.br",
  hml: "appservices-hml.antt.gov.br",
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

const ACOES = {
  testar: null,
  emitir: "DeclaracaoOperacaoTransporte",
  declarar: "DeclaracaoOperacaoTransporte",
  consultar: "ConsultarCIOTGerado",
  consultarciot: "ConsultarCIOTGerado",
  situacao: "ConsultarSituacaoTransportador",
  transportador: "ConsultarSituacaoTransportador",
  frota: "ConsultarFrotaTransportador",
  retificar: "RetificacaoOperacaoTransporte",
  encerrar: "EncerramentoOperacaoTransporte",
  cancelar: "CancelamentoOperacaoTransporte",
  validarCertificado: "ConsultarSituacaoTransportador",
  validarcertificado: "ConsultarSituacaoTransportador",
};

function primeiro(...valores) {
  for (const v of valores) {
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
  }
  return undefined;
}

function chamarAntt({ servico, ambiente, pfxBase64, senha, payload }) {
  if (!SERVICOS.has(servico)) throw new Error(`Serviço inválido: ${servico}`);
  const chave = String(ambiente ?? "prod").toLowerCase();
  const hostname = HOSTS[chave] ?? HOSTS.prod;
  const corpo = JSON.stringify(payload ?? {});
  const pfxLimpo = String(pfxBase64).replace(/\s+/g, "").replace(/^data:[^,]+,/, "");

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
    pfx: Buffer.from(pfxLimpo, "base64"),
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
  const url = req.url ?? "/";
  if (req.method === "OPTIONS") return json(res, 204, {});
  if (req.method === "GET" && url.startsWith("/health")) {
    return json(res, 200, { ok: true, ponte: "no ar", servicos: [...SERVICOS] });
  }

  if (req.method !== "POST") return json(res, 405, { ok: false, erro: "Use POST." });

  const token = process.env.BRIDGE_TOKEN;
  if (token && req.headers["x-bridge-token"] !== token) {
    return json(res, 401, { ok: false, erro: "TOKEN_INVALIDO" });
  }

  let cru = "";
  req.on("data", (c) => {
    cru += c;
    if (cru.length > 6_000_000) req.destroy();
  });
  req.on("end", async () => {
    let body;
    try {
      body = JSON.parse(cru || "{}");
    } catch (_) {
      return json(res, 400, { ok: false, erro: "JSON inválido" });
    }

    const acao = String(primeiro(body.action, body.acao, body.operacao) ?? "").trim();
    const rota = url.split("?")[0];

    // Teste de conectividade da ponte: não exige certificado.
    if (rota === "/testar" || acao.toLowerCase() === "testar") {
      return json(res, 200, { ok: true, ponte: "no ar", servicos: [...SERVICOS] });
    }

    const pfxBase64 = primeiro(
      body.pfxBase64,
      body.pfx_base64,
      body.certificadoBase64,
      body.certificado,
      body.cert_base64,
      body.pfx,
    );
    const senha = primeiro(body.senha, body.password, body.certSenha, body.passphrase) ?? "";
    const ambiente = primeiro(body.ambiente, body.ambient, body.environment) ?? "prod";

    if (!pfxBase64) {
      return json(res, 400, {
        ok: false,
        erro: "CERTIFICADO_AUSENTE",
        mensagem: "Anexe o certificado A1 (.pfx ou .p12) na aba Configuração.",
      });
    }

    let servico;
    if (rota.startsWith("/situacao")) servico = "ConsultarSituacaoTransportador";
    else if (body.servico && SERVICOS.has(body.servico)) servico = body.servico;
    else if (acao && ACOES[acao] !== undefined && ACOES[acao] !== null) servico = ACOES[acao];
    else if (acao && SERVICOS.has(acao)) servico = acao;
    else servico = "DeclaracaoOperacaoTransporte";

    let payload = primeiro(body.payload, body.dados, body.requisicao, body.body);
    if (payload && typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (_) {
        payload = { valor: payload };
      }
    }
    if (!payload || typeof payload !== "object") {
      const cnpj = primeiro(body.cnpj, body.CpfCnpjTransportador, body.cpfCnpjTransportador);
      payload = cnpj ? { CpfCnpjTransportador: String(cnpj).replace(/\D/g, "") } : {};
    }
    if (servico === "ConsultarSituacaoTransportador") {
      const cnpj = primeiro(body.cnpj, payload.CpfCnpjTransportador, payload.cpfCnpjTransportador);
      if (cnpj) payload = { ...payload, CpfCnpjTransportador: String(cnpj).replace(/\D/g, "") };
    }

    try {
      const r = await chamarAntt({ servico, ambiente, pfxBase64, senha, payload });
      return json(res, r.status === 200 ? 200 : r.status || 502, {
        ok: r.status === 200,
        servico,
        ambiente,
        antt_status: r.status,
        antt: r.dados,
        bruto: r.dados ? undefined : r.bruto,
      });
    } catch (e) {
      const msg = String(e?.message ?? e);
      const dica = /mac verify failure|bad decrypt|wrong final block/i.test(msg)
        ? "Senha do certificado incorreta."
        : /not enough data|asn1|no start line/i.test(msg)
          ? "Arquivo não parece ser um .pfx/.p12 válido."
          : undefined;
      return json(res, 502, { ok: false, erro: msg, mensagem: dica });
    }
  });
});

const porta = Number(process.env.PORT ?? 3000);
servidor.listen(porta, () => console.log(`Ponte ANTT ouvindo na porta ${porta}`));
