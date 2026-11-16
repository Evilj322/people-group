(function () {
  'use strict';

  // Каналы отправки, по порядку. Первый, который ответил, и считается.
  // 1) Наш сервер (api/send.js): дубли, воронки, менеджеры, Домопланер.
  //    На GitHub Pages своих функций нет — идём через Netlify (он проксирует в Vercel),
  //    затем напрямую в Vercel (работает у тех, кто с VPN).
  // 2) Запасной: вебхук Prometheus (gnzs, сервер в РФ) — уже подключён к amoCRM,
  //    сервер и сам использует его как резерв. Без проверки дублей.
  var WEBHOOK_URL = 'https://prometheus-api.gnzs.ru/webhook/custom/65354687-2d83-48bc-99a9-0269f021de31/call';
  var SERVER_URLS = /\.github\.io$/.test(location.hostname)
    ? ['https://people-group.netlify.app/api/send', 'https://people-group.vercel.app/api/send']
    : ['/api/send'];
  var CHANNEL_TIMEOUT_MS = 12000;

  var form = document.getElementById('lead-form');
  if (!form) return;
  var btn = document.getElementById('submit-btn');
  var status = document.getElementById('form-status');

  var phoneInput = form.querySelector('input[name="agent_phone"]');
  phoneInput.addEventListener('input', function () {
    var digits = this.value.replace(/\D/g, '').slice(0, 11);
    if (digits.length > 0 && digits[0] === '8') digits = '7' + digits.slice(1);
    if (digits.length > 0 && digits[0] !== '7') digits = '7' + digits;
    var s = '+7';
    if (digits.length > 1) s += ' (' + digits.slice(1, 4);
    if (digits.length >= 4) s += ') ' + digits.slice(4, 7);
    if (digits.length >= 7) s += '-' + digits.slice(7, 9);
    if (digits.length >= 9) s += '-' + digits.slice(9, 11);
    this.value = s;
  });

  // Подсказка и валидация при выборе "Другое" в агентстве
  var agencySelect = form.querySelector('select[name="agency_name"]');
  var otherHint = document.getElementById('other-agency-hint');
  var commentArea = form.querySelector('textarea[name="comment"]');
  if (agencySelect && otherHint) {
    agencySelect.addEventListener('change', function () {
      var isOther = this.value === 'Другое';
      otherHint.style.display = isOther ? '' : 'none';
      if (isOther && commentArea) commentArea.placeholder = 'Укажите название вашего агентства';
      else if (commentArea) commentArea.placeholder = 'Дополнительная информация о клиенте';
    });
  }

  var last4 = form.querySelector('input[name="client_phone_last4"]');
  last4.addEventListener('input', function () {
    this.value = this.value.replace(/\D/g, '').slice(0, 4);
  });

  // Preselect объекта по URL: /form.html?object=Романов
  try {
    var qsObject = new URLSearchParams(location.search).get('object');
    if (qsObject) {
      var sel = form.querySelector('select[name="object"]');
      if (sel) {
        var match = Array.from(sel.options).find(function (o) {
          return o.value && o.value.toLowerCase() === qsObject.toLowerCase();
        });
        if (match) sel.value = match.value;
      }
    }
  } catch (_) {}

  function validate() {
    var ok = true;
    var fields = form.querySelectorAll('input, select, textarea');
    fields.forEach(function (el) {
      el.classList.remove('is-invalid');
      if (el.type === 'checkbox') {
        if (el.required && !el.checked) { ok = false; el.classList.add('is-invalid'); }
        return;
      }
      if (el.required && !el.value.trim()) { ok = false; el.classList.add('is-invalid'); }
    });

    if (last4.value && !/^\d{4}$/.test(last4.value)) {
      ok = false; last4.classList.add('is-invalid');
    }
    // Если выбрано "Другое" — комментарий обязателен
    if (agencySelect && agencySelect.value === 'Другое' && commentArea && !commentArea.value.trim()) {
      ok = false; commentArea.classList.add('is-invalid');
    }
    var digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length < 11) { ok = false; phoneInput.classList.add('is-invalid'); }

    return ok;
  }

  function setLoading(on) {
    if (on) {
      form.classList.add('is-loading');
      btn.disabled = true;
      btn.querySelector('.btn-primary__text').textContent = 'Отправляем…';
    } else {
      form.classList.remove('is-loading');
      btn.disabled = false;
      btn.querySelector('.btn-primary__text').textContent = 'Отправить заявку';
    }
  }

  function setStatus(msg, kind, html) {
    if (html) {
      status.innerHTML = msg || '';
    } else {
      status.textContent = msg || '';
    }
    status.className = 'form-status' + (kind ? ' is-' + kind : '');
  }

  function buildPayload() {
    var fd = new FormData(form);
    var data = {
      agent_name: fd.get('agent_name'),
      agent_phone: fd.get('agent_phone'),
      agency_name: fd.get('agency_name'),
      object: fd.get('object'),
      client_name: fd.get('client_name'),
      client_phone_last4: fd.get('client_phone_last4'),
      manager: fd.get('manager') || '',
      comment: fd.get('comment') || '',
      consent: !!fd.get('consent'),
      source: 'taplink-darsan',
      page_url: location.href,
      submitted_at: new Date().toISOString()
    };
    return data;
  }

  // Парсит ответ нашего прокси /api/send (а также напрямую от хука, если когда-то будет).
  // Прокси возвращает: { ok, duplicate?, message?, upstream?, ... }.
  function interpretResponse(text) {
    var data = null;
    try { data = JSON.parse(text); } catch (_) {}
    if (data && typeof data === 'object') {
      if (data.duplicate === true) {
        return { kind: 'duplicate', message: 'Клиент не уникален' };
      }
      if (data.ok === false || data.success === false || data.result === false) {
        return { kind: 'error', message: data.message || data.error || 'Не удалось обработать заявку.' };
      }
      var nested = String((data.upstream && (data.upstream.message || data.upstream)) || data.message || '');
      if (/дубл|уже зафикс|уже закреплен|already exists/i.test(nested)) {
        return { kind: 'duplicate', message: 'Клиент не уникален' };
      }
      return { kind: 'success', message: 'Клиент успешно зафиксирован' };
    }
    var lower = String(text || '').toLowerCase();
    if (/дубл|уже зафикс|уже закреплен|already exists/i.test(lower)) {
      return { kind: 'duplicate', message: 'Клиент не уникален' };
    }
    if (/ошибк|fail|error/i.test(lower)) {
      return { kind: 'error', message: text || 'Не удалось обработать заявку.' };
    }
    return { kind: 'success', message: 'Клиент успешно зафиксирован' };
  }

  // Дедуп выполняется на сервере (Upstash KV в /api/send.js) — он отдаёт
  // duplicate:true при повторе с любого устройства. На клиенте ничего не храним.

  var DUPLICATE_HTML = 'Клиент уже зафиксирован к ОП, но вы можете с ним работать и закрывать на бронь. Детали узнайте у менеджеров ОП:<br><br>' +
    '<a href="tel:+79148755457" style="display:block;color:inherit;font-weight:600;text-decoration:none">+7 914 875 54 57 — Арсений (руководитель ПО)</a>';

  function renderResult(result) {
    setLoading(false);
    form.classList.add('is-sent');
    if (result.kind === 'duplicate') {
      setStatus(DUPLICATE_HTML, 'warning', true);
    } else {
      setStatus(result.message, result.kind === 'success' ? 'success' : 'error');
    }
  }

  function postPayload(url, payload) {
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, CHANNEL_TIMEOUT_MS) : null;
    return fetch(url, {
      method: 'POST',
      mode: 'cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (res) {
      return res.text().then(function (txt) {
        if (timer) clearTimeout(timer);
        return { ok: res.ok, status: res.status, text: txt };
      });
    }, function (err) {
      if (timer) clearTimeout(timer);
      throw err;
    });
  }

  // Пробует серверные адреса по очереди. Сетевая ошибка, таймаут или 5xx —
  // переходим к следующему. Ответ 4xx — это ответ сервера, его показываем.
  function sendToServer(payload, i) {
    if (i >= SERVER_URLS.length) return Promise.reject(new Error('server unreachable'));
    return postPayload(SERVER_URLS[i], payload).then(function (resp) {
      if (resp.status >= 500) return sendToServer(payload, i + 1);
      return resp;
    }, function (err) {
      console.warn('channel failed:', SERVER_URLS[i], err);
      return sendToServer(payload, i + 1);
    });
  }

  function sendToPrometheus(payload) {
    var p = {
      agent_name: payload.agent_name,
      agent_phone: payload.agent_phone,
      agency_name: payload.agency_name,
      object: payload.object,
      client_name: payload.client_name,
      client_phone_last4: payload.client_phone_last4,
      manager: payload.manager,
      comment: [payload.comment, payload.manager ? 'Менеджер: ' + payload.manager : '']
        .filter(Boolean).join('\n'),
      source: payload.source + '-fallback',
      page_url: payload.page_url,
      submitted_at: payload.submitted_at
    };
    return postPayload(WEBHOOK_URL, p);
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    setStatus('', null);
    if (!validate()) {
      setStatus('Заполните поля, отмеченные красным.', 'error');
      return;
    }

    var payload = buildPayload();
    setLoading(true);

    sendToServer(payload, 0)
      .then(function (resp) {
        if (!resp.ok) {
          setLoading(false);
          setStatus('Не удалось отправить. Проверьте поля и попробуйте ещё раз.', 'error');
          console.error('server answered', resp.status, resp.text);
          return;
        }
        renderResult(interpretResponse(resp.text));
      }, function () {
        // Сервер недоступен ни по одному адресу — отправляем через Prometheus.
        return sendToPrometheus(payload).then(function (resp) {
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          renderResult({ kind: 'success', message: 'Клиент успешно зафиксирован' });
        });
      })
      .catch(function (err) {
        setLoading(false);
        setStatus('Не удалось отправить. Позвоните по номеру из контактов ниже.', 'error');
        console.error(err);
      });
  });
})();
