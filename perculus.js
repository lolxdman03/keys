// Perculus Otomatik Yoklama - ana kod (GitHub'da durur, loader çeker)
(function () {

    'use strict';

    // =========================================================================
    // CONFIGURATION
    // =========================================================================
    const CONFIG = {
        // Kesin yoklama buton metinleri - Derse katılma vb. butonları asla tetiklemez!
        buttonTexts: [
            'buradayım!',
            'buradayım',
            'burdayım!',
            'burdayım',
            'ben buradayım',
            'ben burdayım',
            'buradayim!',
            'buradayim',
            'burdayim!',
            'burdayim',
            'ben buradayim',
            'ben burdayim',
            'yoklamaya katıl',
            'yoklamaya katil',
            'yoklamayı onayla',
            'yoklamayi onayla',
            'yoklama onayla',
            'i am here',
            "i'm here",
            'present',
            'confirm attendance',
        ],

        // Asla tıklanmaması gereken yasaklı kelimeler (derse girme, mikrofon, kamera, oda değiştirme vs.)
        forbiddenTexts: [
            'oturuma katıl',
            'derse katıl',
            'sanal sınıfa',
            'odaya katıl',
            'mikrofon',
            'kamera',
            'ayrıl',
            'çıkış',
            'giriş yap',
            'oturumdan çık',
            'başlat',
            'yayın',
            'paylaş',
            'sohbet',
        ],

        // Buton olabilecek HTML element tipleri
        buttonElements: ['button', 'a', 'div', 'span', 'input'],

        // Butonun olabileceği attribute'lar (aria-label, title, value, data-*)
        buttonAttributes: ['aria-label', 'title', 'value', 'data-text', 'data-label', 'data-tooltip', 'data-content'],

        // Tıklama sonrası bekleme süresi (ms) - aynı butona tekrar tıklamamak için
        clickCooldownMs: 5000,

        // Polling interval (ms) - Buton 20-45sn göründüğü için agresif tarama
        pollingIntervalMs: 500,

        // MutationObserver debounce süresi (ms) - hızlı tepki
        observerDebounceMs: 80,

        // Bildirim göster (Tampermonkey notification)
        showNotifications: true,

        // Konsol log seviyesi: 'debug', 'info', 'warn', 'error'
        logLevel: 'info',

        // Overlay panel göster
        showOverlayPanel: true,

        // Ses çal tıklama yapıldığında
        playSoundOnClick: true,

        // Overlay panel pozisyonu
        panelPosition: 'bottom-right', // 'top-left', 'top-right', 'bottom-left', 'bottom-right'
    };

    // =========================================================================
    // STATE
    // =========================================================================
    const STATE = {
        totalClicks: 0,
        lastClickTime: 0,
        lastClickedText: '',
        isActive: true,
        startTime: Date.now(),
        scanCount: 0,
        buttonsFound: 0,
        recentClicks: [],
        observer: null,
        pollingTimer: null,
        debounceTimer: null,
    };

    // =========================================================================
    // LOGGING
    // =========================================================================
    const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

    function log(level, ...args) {
        if (LOG_LEVELS[level] >= LOG_LEVELS[CONFIG.logLevel]) {
            const timestamp = new Date().toLocaleTimeString('tr-TR');
            const prefix = `[Perculus-Auto ${timestamp}]`;
            switch (level) {
                case 'debug': console.debug(prefix, ...args); break;
                case 'info': console.info(prefix, ...args); break;
                case 'warn': console.warn(prefix, ...args); break;
                case 'error': console.error(prefix, ...args); break;
            }
        }
    }

    // =========================================================================
    // SOUND GENERATOR (Web Audio API - bağımlılık yok)
    // =========================================================================
    function playClickSound() {
        if (!CONFIG.playSoundOnClick) return;
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const gainNode = audioCtx.createGain();

            oscillator.connect(gainNode);
            gainNode.connect(audioCtx.destination);

            oscillator.type = 'sine';
            oscillator.frequency.setValueAtTime(880, audioCtx.currentTime);
            oscillator.frequency.setValueAtTime(1100, audioCtx.currentTime + 0.05);
            oscillator.frequency.setValueAtTime(880, audioCtx.currentTime + 0.1);

            gainNode.gain.setValueAtTime(0.15, audioCtx.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3);

            oscillator.start(audioCtx.currentTime);
            oscillator.stop(audioCtx.currentTime + 0.3);

            setTimeout(() => audioCtx.close(), 500);
        } catch (e) {
            log('debug', 'Ses çalınamadı:', e.message);
        }
    }

    // =========================================================================
    // NOTIFICATION
    // =========================================================================
    function notify(title, text) {
        if (!CONFIG.showNotifications) return;
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({ title, text, timeout: 4000 });
            }
        } catch (e) {
            log('debug', 'GM_notification kullanılamıyor:', e.message);
        }
        log('info', `📢 ${title}: ${text}`);
    }

    // =========================================================================
    // TEXT NORMALIZATION
    // =========================================================================
    function normalizeText(text) {
        if (!text) return '';
        return text
            .toLowerCase()
            .replace(/İ/g, 'i')
            .replace(/I/g, 'ı')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function textMatchesAttendance(text) {
        const normalized = normalizeText(text);
        if (!normalized || normalized.length === 0) return false;
        // Çok uzun metinler yoklama butonu olamaz
        if (normalized.length > 50) return false;

        // Yasaklı kelime içeriyorsa asla tıklama (Derse katıl, oturum, kamera vs.)
        for (const forbidden of CONFIG.forbiddenTexts) {
            if (normalized.includes(forbidden)) return false;
        }

        // Kesin yoklama buton kontrolleri
        for (const target of CONFIG.buttonTexts) {
            if (normalized === target) return true;
            // Eğer buton metninde net olarak geçiyorsa ve çok uzamadıysa
            if (normalized.includes(target) && normalized.length < 25) return true;
        }
        return false;
    }

    // =========================================================================
    // ELEMENT VISIBILITY CHECK
    // =========================================================================
    function isElementVisible(el) {
        if (!el) return false;
        if (el.offsetParent === null && el.style.position !== 'fixed' && el.style.position !== 'sticky') {
            return false;
        }
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            return false;
        }
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;

        return true;
    }

    // =========================================================================
    // CLICK SIMULATION (React uyumlu)
    // =========================================================================
    function simulateClick(element) {
        try {
            // Önce native click dene
            element.focus();

            // MouseEvent'ler - React'in SyntheticEvent sistemi için
            const mouseDownEvent = new MouseEvent('mousedown', {
                bubbles: true, cancelable: true, view: window
            });
            const mouseUpEvent = new MouseEvent('mouseup', {
                bubbles: true, cancelable: true, view: window
            });
            const clickEvent = new MouseEvent('click', {
                bubbles: true, cancelable: true, view: window
            });

            element.dispatchEvent(mouseDownEvent);

            setTimeout(() => {
                element.dispatchEvent(mouseUpEvent);
                setTimeout(() => {
                    element.dispatchEvent(clickEvent);

                    // Fallback: native click
                    setTimeout(() => {
                        try { element.click(); } catch (e) { /* ignore */ }
                    }, 50);

                    // React internal props üzerinden handler'ı tetikle
                    setTimeout(() => {
                        triggerReactClickHandler(element);
                    }, 100);

                }, 30);
            }, 30);

            return true;
        } catch (e) {
            log('error', 'Click simulation hatası:', e.message);
            try { element.click(); return true; } catch (e2) { return false; }
        }
    }

    // =========================================================================
    // REACT INTERNAL CLICK HANDLER TRIGGER
    // =========================================================================
    function triggerReactClickHandler(element) {
        try {
            // React 16+ fiber node'larından onClick handler'ı bul
            const reactKeys = Object.keys(element).filter(
                key => key.startsWith('__reactInternalInstance') ||
                       key.startsWith('__reactFiber') ||
                       key.startsWith('__reactProps') ||
                       key.startsWith('__reactEvents')
            );

            for (const key of reactKeys) {
                const value = element[key];
                if (!value) continue;

                // __reactProps üzerinden onClick
                if (key.startsWith('__reactProps') && value.onClick) {
                    log('debug', 'React onClick handler bulundu, tetikleniyor...');
                    value.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: element, currentTarget: element });
                    return;
                }

                // Fiber node üzerinden memoizedProps
                if (value && value.memoizedProps && value.memoizedProps.onClick) {
                    log('debug', 'React fiber onClick handler bulundu, tetikleniyor...');
                    value.memoizedProps.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: element, currentTarget: element });
                    return;
                }

                // Statenode üzerinden props
                if (value && value.stateNode && value.stateNode.props && value.stateNode.props.onClick) {
                    log('debug', 'React stateNode onClick handler bulundu, tetikleniyor...');
                    value.stateNode.props.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: element, currentTarget: element });
                    return;
                }
            }

            // Parent element'lerde de ara (event delegation)
            let parent = element.parentElement;
            let depth = 0;
            while (parent && depth < 5) {
                const parentReactKeys = Object.keys(parent).filter(
                    key => key.startsWith('__reactProps')
                );
                for (const key of parentReactKeys) {
                    const value = parent[key];
                    if (value && value.onClick) {
                        log('debug', 'Parent React onClick handler bulundu (depth:', depth, ')');
                        value.onClick({ preventDefault: () => {}, stopPropagation: () => {}, target: element, currentTarget: parent });
                        return;
                    }
                }
                parent = parent.parentElement;
                depth++;
            }
        } catch (e) {
            log('debug', 'React handler tetikleme hatası (önemsiz):', e.message);
        }
    }

    // =========================================================================
    // BUTTON SCANNER
    // =========================================================================
    function findAttendanceButtons() {
        const candidates = [];
        STATE.scanCount++;

        // Strateji 1: Tüm tıklanabilir element'leri tara (button, a, [role=button])
        const clickables = document.querySelectorAll(
            'button, a, [role="button"], input[type="button"], input[type="submit"], ' +
            'div[onclick], span[onclick], div[tabindex], span[tabindex], ' +
            '.btn, .button, [class*="btn"], [class*="button"], [class*="Button"]'
        );

        for (const el of clickables) {
            // textContent kontrolü
            const textContent = el.textContent || el.innerText || '';
            if (textMatchesAttendance(textContent)) {
                if (isElementVisible(el)) {
                    candidates.push({ element: el, source: 'text', matchedText: textContent.trim().substring(0, 30) });
                    continue;
                }
            }

            // Attribute kontrolü
            for (const attr of CONFIG.buttonAttributes) {
                const attrValue = el.getAttribute(attr);
                if (attrValue && textMatchesAttendance(attrValue)) {
                    if (isElementVisible(el)) {
                        candidates.push({ element: el, source: `attr:${attr}`, matchedText: attrValue.trim().substring(0, 30) });
                        break;
                    }
                }
            }
        }

        // Strateji 2: XPath ile metin bazlı arama (daha derin)
        for (const targetText of CONFIG.buttonTexts) {
            try {
                const xpathQuery = `//*[contains(translate(text(), 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZ', 'abcçdefgğhıijklmnoöprsştuüvyz'), '${targetText}')]`;
                const xpathResult = document.evaluate(
                    xpathQuery, document, null,
                    XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null
                );

                for (let i = 0; i < xpathResult.snapshotLength; i++) {
                    const el = xpathResult.snapshotItem(i);
                    if (!el || !isElementVisible(el)) continue;

                    // Zaten candidates'da var mı kontrol et
                    const alreadyFound = candidates.some(c => c.element === el || c.element.contains(el) || el.contains(c.element));
                    if (!alreadyFound) {
                        candidates.push({ element: el, source: 'xpath', matchedText: (el.textContent || '').trim().substring(0, 30) });
                    }
                }
            } catch (e) {
                // XPath hatası - devam et
            }
        }

        // Strateji 3: Shadow DOM içinde ara
        const shadowHosts = document.querySelectorAll('*');
        for (const host of shadowHosts) {
            if (host.shadowRoot) {
                try {
                    const shadowButtons = host.shadowRoot.querySelectorAll('button, a, [role="button"]');
                    for (const el of shadowButtons) {
                        const text = el.textContent || '';
                        if (textMatchesAttendance(text) && isElementVisible(el)) {
                            candidates.push({ element: el, source: 'shadow', matchedText: text.trim().substring(0, 30) });
                        }
                    }
                } catch (e) { /* Shadow DOM erişim hatası */ }
            }
        }

        // Strateji 4: Modal/Dialog/Popup container'larını özel tara
        const modals = document.querySelectorAll(
            '[class*="modal"], [class*="Modal"], [class*="dialog"], [class*="Dialog"], ' +
            '[class*="popup"], [class*="Popup"], [class*="overlay"], [class*="Overlay"], ' +
            '[class*="alert"], [class*="Alert"], [class*="toast"], [class*="Toast"], ' +
            '[class*="notification"], [class*="Notification"], [class*="attendance"], ' +
            '[class*="Attendance"], [class*="yoklama"], [class*="Yoklama"], ' +
            '[role="dialog"], [role="alertdialog"], [aria-modal="true"]'
        );

        for (const modal of modals) {
            if (!isElementVisible(modal)) continue;

            const modalButtons = modal.querySelectorAll('button, a, [role="button"], div, span');
            for (const btn of modalButtons) {
                const text = btn.textContent || '';
                if (textMatchesAttendance(text) && isElementVisible(btn)) {
                    const alreadyFound = candidates.some(c => c.element === btn);
                    if (!alreadyFound) {
                        candidates.push({ element: btn, source: 'modal', matchedText: text.trim().substring(0, 30) });
                    }
                }
            }
        }

        // iframe'leri de tara (aynı origin ise)
        const iframes = document.querySelectorAll('iframe');
        for (const iframe of iframes) {
            try {
                const iframeDoc = iframe.contentDocument || iframe.contentWindow.document;
                if (!iframeDoc) continue;

                const iframeButtons = iframeDoc.querySelectorAll('button, a, [role="button"]');
                for (const btn of iframeButtons) {
                    const text = btn.textContent || '';
                    if (textMatchesAttendance(text)) {
                        candidates.push({ element: btn, source: 'iframe', matchedText: text.trim().substring(0, 30) });
                    }
                }
            } catch (e) { /* Cross-origin iframe - erişilemez */ }
        }

        STATE.buttonsFound = candidates.length;
        return candidates;
    }

    // =========================================================================
    // CLICK HANDLER
    // =========================================================================
    function processAttendanceButtons() {
        if (!STATE.isActive) return;

        const now = Date.now();

        // Cooldown kontrolü
        if (now - STATE.lastClickTime < CONFIG.clickCooldownMs) {
            log('debug', `Cooldown aktif, ${Math.round((CONFIG.clickCooldownMs - (now - STATE.lastClickTime)) / 1000)}s kaldı`);
            return;
        }

        const buttons = findAttendanceButtons();

        if (buttons.length === 0) {
            log('debug', `Tarama #${STATE.scanCount}: Yoklama butonu bulunamadı`);
            return;
        }

        log('info', `🎯 ${buttons.length} yoklama butonu bulundu!`);

        for (const candidate of buttons) {
            const { element, source, matchedText } = candidate;

            log('info', `⚡ Tıklanıyor: "${matchedText}" (kaynak: ${source})`);

            const clicked = simulateClick(element);

            if (clicked) {
                STATE.totalClicks++;
                STATE.lastClickTime = now;
                STATE.lastClickedText = matchedText;
                STATE.recentClicks.push({
                    time: new Date().toLocaleTimeString('tr-TR'),
                    text: matchedText,
                    source: source,
                });

                // Son 20 tıklamayı tut
                if (STATE.recentClicks.length > 20) {
                    STATE.recentClicks.shift();
                }

                playClickSound();
                notify('✅ Yoklama Tıklandı!', `"${matchedText}" butonuna otomatik tıklandı.`);
                updateOverlayPanel();

                log('info', `✅ Başarılı! Toplam: ${STATE.totalClicks
