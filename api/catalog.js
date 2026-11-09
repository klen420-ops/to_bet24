const catalog = require("../catalog.json");

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      ok: false,
      error: "Допустим только запрос GET."
    });
  }

  const webhookBase = process.env.BITRIX_WEBHOOK_BASE;

  if (!webhookBase) {
    return res.status(500).json({
      ok: false,
      error: "На сервере не настроена переменная BITRIX_WEBHOOK_BASE."
    });
  }

  try {
    const base = new URL(webhookBase.trim());

    // Здесь нужен базовый адрес вебхука, без названия метода.
    if (
      base.protocol !== "https:" ||
      !/^\/rest\/\d+\/[^/]+\/?$/.test(base.pathname) ||
      base.search ||
      base.hash
    ) {
      return res.status(500).json({
        ok: false,
        error: "Неверный формат BITRIX_WEBHOOK_BASE."
      });
    }

    if (!base.pathname.endsWith("/")) {
      base.pathname += "/";
    }

    if (
      !Array.isArray(catalog) ||
      catalog.length === 0 ||
      catalog.some(
        product =>
          !product.id ||
          !product.name ||
          !product.externalId ||
          !/^\d+$/.test(String(product.bitrixId))
      )
    ) {
      throw new Error("Некорректный каталог.");
    }

    const crmProducts = [];
    let start = 0;

    // Битрикс может возвращать каталог несколькими страницами.
    while (true) {
      const response = await fetch(
        new URL("crm.product.list.json", base),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            filter: {
              ID: catalog.map(product => Number(product.bitrixId))
            },
            select: [
              "ID",
              "XML_ID",
              "PRICE",
              "CURRENCY_ID"
            ],
            start
          }),
          signal: AbortSignal.timeout(10000)
        }
      );

      if (!response.ok) {
        throw new Error("Ошибка ответа CRM.");
      }

      const data = await response.json();

      if (data.error || !Array.isArray(data.result)) {
        throw new Error("Некорректный ответ CRM.");
      }

      crmProducts.push(...data.result);

      if (data.next === undefined || data.next === null) {
        break;
      }

      const next = Number(data.next);

      if (!Number.isSafeInteger(next) || next <= start) {
        throw new Error("Ошибка загрузки страниц каталога.");
      }

      start = next;
    }

    const productsById = new Map(
      crmProducts.map(product => [String(product.ID), product])
    );

    const products = catalog.map(product => {
      const crmProduct = productsById.get(String(product.bitrixId));

      if (
        !crmProduct ||
        crmProduct.XML_ID !== product.externalId ||
        crmProduct.CURRENCY_ID !== "RUB" ||
        crmProduct.PRICE === null ||
        crmProduct.PRICE === undefined ||
        String(crmProduct.PRICE).trim() === ""
      ) {
        throw new Error("Не удалось сопоставить товар или получить цену.");
      }

      const price = Number(crmProduct.PRICE);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error("Некорректная цена.");
      }

      return {
        id: String(product.id),
        name: product.name,
        price,
        currency: "RUB"
      };
    });

    return res.status(200).json({
      ok: true,
      products
    });
  } catch {
    return res.status(502).json({
      ok: false,
      error:
        "Не удалось загрузить каталог из Битрикс24. Проверьте вебхук, права CRM и сопоставление товаров."
    });
  }
};