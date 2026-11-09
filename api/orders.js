const { createHash } = require('node:crypto');
const catalog = require('../catalog.json');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Допустим только POST.' });
  }

  const deadline = Date.now() + 50000;
  let state;
  let claimed = false;
  function fail(message, status = 502) {
    const error = new Error(message);
    error.status = status;
    throw error;
  }
  function signal() {
    const remaining = deadline - Date.now();
    if (remaining < 500) fail('Превышено время ожидания.');
    return AbortSignal.timeout(Math.min(10000, remaining));
  }

  try {
    // Браузер должен отправлять запрос с этого же сайта.
    let origin;
    try { origin = new URL(req.headers.origin); } catch {}
    if (!origin || origin.host !== req.headers.host || origin.protocol !== 'https:') {
      fail('Отправляйте заказ через страницу сайта.', 403);
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
      fail('Ожидается JSON.', 415);
    }

    const env = process.env;
    if (!env.BITRIX_WEBHOOK_BASE || !env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
      fail('Не настроены переменные окружения Битрикс24 или Redis.', 503);
    }
    const base = new URL(env.BITRIX_WEBHOOK_BASE.trim());
    const redisUrl = new URL(env.UPSTASH_REDIS_REST_URL.trim());
    if (base.protocol !== 'https:' || !/^\/rest\/\d+\/[^/]+\/?$/.test(base.pathname) || base.search || base.hash || redisUrl.protocol !== 'https:') {
      fail('Некорректная конфигурация сервера.', 503);
    }
    if (!base.pathname.endsWith('/')) base.pathname += '/';

    async function redis(...command) {
      const response = await fetch(redisUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.UPSTASH_REDIS_REST_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(command),
        signal: signal()
      });
      if (!response.ok) fail('Хранилище заказов недоступно.', 503);
      const data = await response.json();
      if (data.error || !Object.hasOwn(data, 'result')) fail('Ошибка хранилища заказов.', 503);
      return data.result;
    }
    async function crm(method, payload) {
      const response = await fetch(new URL(`${method}.json`, base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: signal()
      });
      if (!response.ok) fail(`Битрикс24 не подтвердил операцию ${method}.`);
      const data = await response.json();
      if (data.error || data.result === undefined || data.result === null || data.result === false) {
        fail(`Битрикс24 не подтвердил операцию ${method}.`);
      }
      return data.result;
    }

    let order;
    try {
      const raw = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!raw || Buffer.byteLength(raw) > 65536) fail('Пустой или слишком большой заказ.', 413);
      order = JSON.parse(raw);
    } catch (error) {
      fail(error.status ? error.message : 'Некорректный JSON.', error.status || 400);
    }
    if (!order || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(order.request_id || '')) {
      fail('Некорректный номер запроса.', 400);
    }
    const contact = order.contact;
    if (!contact || typeof contact.full_name !== 'string' || !contact.full_name.trim() || contact.full_name.length > 150) fail('Укажите ФИО.', 400);
    if (typeof contact.phone !== 'string' || contact.phone.length > 30 || !/^[+\d\s()\-]+$/.test(contact.phone) || !/^\d{7,15}$/.test(contact.phone.replace(/\D/g, ''))) fail('Некорректный телефон.', 400);
    if (typeof contact.email !== 'string' || contact.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) fail('Некорректный email.', 400);
    if (!Array.isArray(order.items) || !order.items.length || order.items.length > 100) fail('Выберите от 1 до 100 позиций.', 400);

    const byId = new Map(catalog.map(p => [String(p.id), p]));
    const merged = new Map();
    for (const item of order.items) {
      const id = String(item?.id);
      if (!byId.has(id) || !Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 1000000 || typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0) fail('Некорректный товар, цена или количество.', 400);
      const previous = merged.get(id);
      if (previous && previous.price !== item.price) fail('У одного товара указаны разные цены.', 400);
      const quantity = (previous?.quantity || 0) + item.quantity;
      if (quantity > 1000000) fail('Слишком большое количество товара.', 400);
      merged.set(id, { id, quantity, price: item.price });
    }
    const items = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
    const cleanContact = { full_name: contact.full_name.trim(), phone: contact.phone.trim(), email: contact.email.trim() };
    const hash = createHash('sha256').update(JSON.stringify({ contact: cleanContact, items })).digest('hex');
    const namespace = createHash('sha256').update(base.origin).digest('hex').slice(0, 16);
    const key = `orders:${namespace}:${order.request_id.toLowerCase()}`;
    function previousResult(value) {
      if (!value) fail('Не удалось проверить предыдущую отправку.', 503);
      const previous = JSON.parse(value);
      if (previous.hash !== hash) fail('Этот номер запроса уже использован для другого заказа.', 409);
      if (previous.stage === 'done') {
        return res.status(200).json({ ok: true, contact_id: previous.contactId, deal_id: previous.dealId });
      }
      fail(`Заказ уже обрабатывался. Этап: ${previous.stage}. Сделка: ${previous.dealId || 'не подтверждена'}. Проверьте CRM; повторное создание заблокировано.`, 409);
    }
    const previous = await redis('GET', key);
    if (previous) return previousResult(previous);

    // Цены проверяем на сервере; подмена цены в браузере не проходит.
    const current = await crm('crm.product.list', {
      filter: { ID: items.map(item => Number(byId.get(item.id).bitrixId)) },
      select: ['ID', 'XML_ID', 'PRICE', 'CURRENCY_ID', 'ACTIVE']
    });
    if (!Array.isArray(current)) fail('Не удалось проверить каталог.');
    const crmRows = items.map(item => {
      const product = byId.get(item.id);
      const match = current.find(p => String(p.ID) === String(product.bitrixId) && p.XML_ID === product.externalId);
      if (!match || match.ACTIVE !== 'Y' || match.CURRENCY_ID !== 'RUB' || match.PRICE === null || match.PRICE === undefined || String(match.PRICE).trim() === '' || !Number.isFinite(Number(match.PRICE)) || Number(match.PRICE) < 0) fail('Товар недоступен или его цена не найдена.');
      if (Number(match.PRICE) !== item.price) fail('Цена изменилась. Обновите страницу и проверьте заказ.', 409);
      return { PRODUCT_ID: Number(product.bitrixId), QUANTITY: item.quantity, PRICE: Number(match.PRICE) };
    });

    // SET NX разрешает только одному параллельному запросу начать отправку.
    // Запись не удаляется по таймеру: при обрыве связи повтор не создаёт дубликат.
    state = { hash, stage: 'contact_pending', contactId: null, dealId: null };
    const acquired = await redis('SET', key, JSON.stringify(state), 'NX');
    if (acquired !== 'OK') return previousResult(await redis('GET', key));
    claimed = true;
    async function save(stage) {
      state.stage = stage;
      if (await redis('SET', key, JSON.stringify(state)) !== 'OK') fail('Не удалось сохранить состояние заказа.', 503);
    }
    function crmId(value) {
      if (!Number.isSafeInteger(Number(value)) || Number(value) <= 0) fail('CRM не вернула корректный ID.');
      return Number(value);
    }
    const parts = cleanContact.full_name.split(/\s+/);
    state.contactId = crmId(await crm('crm.contact.add', { fields: {
      NAME: parts.length === 1 ? parts[0] : parts[1],
      LAST_NAME: parts.length === 1 ? '' : parts[0],
      SECOND_NAME: parts.slice(2).join(' '),
      PHONE: [{ VALUE: cleanContact.phone, VALUE_TYPE: 'WORK' }],
      EMAIL: [{ VALUE: cleanContact.email, VALUE_TYPE: 'WORK' }],
      ORIGINATOR_ID: 'vercel_order_form', ORIGIN_ID: order.request_id
    } }));
    await save('deal_pending');
    state.dealId = crmId(await crm('crm.deal.add', { fields: {
      TITLE: `ТЕСТ — заказ с формы — ${order.request_id}`,
      CONTACT_IDS: [state.contactId], CURRENCY_ID: 'RUB',
      ORIGINATOR_ID: 'vercel_order_form', ORIGIN_ID: order.request_id,
      COMMENTS: `ФИО: ${cleanContact.full_name}. Запрос: ${order.request_id}. Цены проверены по каталогу CRM.`
    } }));
    await save('rows_pending');
    await crm('crm.deal.productrows.set', { id: state.dealId, rows: crmRows });
    const actual = await crm('crm.deal.productrows.get', { id: state.dealId });
    if (!Array.isArray(actual) || actual.length !== crmRows.length || !crmRows.every(row => actual.filter(p => Number(p.PRODUCT_ID) === row.PRODUCT_ID && Number(p.QUANTITY) === row.QUANTITY && Number(p.PRICE) === row.PRICE).length === 1)) fail('Не удалось подтвердить состав заказа в CRM.');
    await save('done');
    return res.status(200).json({ ok: true, contact_id: state.contactId, deal_id: state.dealId });
  } catch (error) {
    const message = error.status ? error.message : 'Сервис временно недоступен или превышено время ожидания.';
    return res.status(error.status || 502).json({
      ok: false,
      error: claimed ? `${message} Возможна частичная запись в CRM. Сделка: ${state?.dealId || 'не подтверждена'}. Проверьте CRM перед новым заказом.` : message
    });
  }
};
