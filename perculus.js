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
    // SELF-ELEMENT EXCLUSION (kendi panelimize ve key overlay'e tıklamayı önle)
    // =========================================================================
    function isOwnElement(el) {
        if (!el) return true;
        // Kendi overlay panelimiz
        const panel = document.getElementById('perculus-auto-panel');
        if (panel && (el === panel || panel.contains(el))) return true;
        // Key prompt overlay elementimiz
        const keyOverlay = document.getElementById('perculus-key-overlay');
        if (keyOverlay && (el === keyOverlay || keyOverlay.contains(el))) return true;
        // Tampermonkey & Greasemonkey UI elementleri
        if (el.closest && el.closest('#perculus-auto-panel')) return true;
        if (el.closest && el.closest('#perculus-key-overlay')) return true;
        if (el.closest && el.closest('[id*="tampermonkey"]')) return true;
        if (el.closest && el.closest('[class*="tampermonkey"]')) return true;
        if (el.closest && el.closest('[id*="greasemonkey"]')) return true;
        // Shadow root check
        const root = el.getRootNode && el.getRootNode();
        if (root && root.host && (root.host.id === 'perculus-auto-panel' || root.host.id === 'perculus-key-overlay')) return true;
        return false;
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
            // Kendi panelimizi ve key overlay'i atla
            if (isOwnElement(el)) continue;

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
                    if (!el || !isElementVisible(el) || isOwnElement(el)) continue;

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
                        if (textMatchesAttendance(text) && isElementVisible(el) && !isOwnElement(el)) {
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
            if (!isElementVisible(modal) || isOwnElement(modal)) continue;

            const modalButtons = modal.querySelectorAll('button, a, [role="button"], div, span');
            for (const btn of modalButtons) {
                const text = btn.textContent || '';
                if (textMatchesAttendance(text) && isElementVisible(btn) && !isOwnElement(btn)) {
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
                    if (textMatchesAttendance(text) && !isOwnElement(btn)) {
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

                log('info', `✅ Başarılı! Toplam: ${STATE.totalClicks} tıklama`);

                // Bir buton tıklandıktan sonra diğerlerini bekleme
                break;
            } else {
                log('warn', `❌ Tıklama başarısız: "${matchedText}"`);
            }
        }
    }

    // =========================================================================
    // MUTATION OBSERVER (DOM değişikliklerini izle)
    // =========================================================================
    function startMutationObserver() {
        if (STATE.observer) {
            STATE.observer.disconnect();
        }

        STATE.observer = new MutationObserver((mutations) => {
            // Debounce: çok sık tetiklenmesin
            if (STATE.debounceTimer) {
                clearTimeout(STATE.debounceTimer);
            }

            STATE.debounceTimer = setTimeout(() => {
                let shouldScan = false;

                for (const mutation of mutations) {
                    // Yeni node eklenmiş mi?
                    if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                        for (const node of mutation.addedNodes) {
                            if (node.nodeType === Node.ELEMENT_NODE) {
                                // Kendi panel'imizi, key modal'ı ve içindeki tüm child'ları ignore et
                                if (isOwnElement(node)) continue;

                                const text = node.textContent || '';
                                if (textMatchesAttendance(text)) {
                                    shouldScan = true;
                                    break;
                                }

                                // Modal/dialog/popup eklendi mi?
                                const tagLower = (node.tagName || '').toLowerCase();
                                const classStr = (node.className || '').toString().toLowerCase();
                                if (
                                    classStr.includes('modal') || classStr.includes('dialog') ||
                                    classStr.includes('popup') || classStr.includes('overlay') ||
                                    classStr.includes('alert') || classStr.includes('attendance') ||
                                    classStr.includes('yoklama') || classStr.includes('notification') ||
                                    classStr.includes('quiz') || classStr.includes('question') ||
                                    classStr.includes('soru') || classStr.includes('quick') ||
                                    classStr.includes('toast') || classStr.includes('snack') ||
                                    classStr.includes('banner') || classStr.includes('prompt') ||
                                    node.getAttribute('role') === 'dialog' ||
                                    node.getAttribute('role') === 'alertdialog' ||
                                    node.getAttribute('aria-modal') === 'true'
                                ) {
                                    shouldScan = true;
                                    break;
                                }

                                // Perculus "Çabuk düşün!" popup metin tespiti
                                const nodeText = (node.textContent || '').toLowerCase();
                                if (
                                    nodeText.includes('çabuk') || nodeText.includes('düşün') ||
                                    nodeText.includes('düğme') || nodeText.includes('puan') ||
                                    nodeText.includes('buradayım') || nodeText.includes('burdayım')
                                ) {
                                    shouldScan = true;
                                    log('info', '🎯 Perculus yoklama popup algılandı!');
                                    break;
                                }
                            }
                        }
                    }

                    // Attribute değişmiş mi? (visibility/display değişiklikleri)
                    if (mutation.type === 'attributes') {
                        const el = mutation.target;
                        if (el.nodeType === Node.ELEMENT_NODE && !isOwnElement(el)) {
                            const text = el.textContent || '';
                            if (textMatchesAttendance(text)) {
                                shouldScan = true;
                            }
                        }
                    }

                    if (shouldScan) break;
                }

                if (shouldScan) {
                    log('debug', 'MutationObserver: Yoklama butonu olabilecek değişiklik algılandı');
                    processAttendanceButtons();
                }
            }, CONFIG.observerDebounceMs);
        });

        // Tüm DOM tree'yi izle
        STATE.observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['style', 'class', 'hidden', 'aria-hidden', 'display'],
        });

        log('info', '👁️ MutationObserver başlatıldı - DOM değişiklikleri izleniyor');
    }

    // =========================================================================
    // POLLING (Yedek mekanizma)
    // =========================================================================
    function startPolling() {
        if (STATE.pollingTimer) {
            clearInterval(STATE.pollingTimer);
        }

        STATE.pollingTimer = setInterval(() => {
            if (STATE.isActive) {
                processAttendanceButtons();
            }
        }, CONFIG.pollingIntervalMs);

        log('info', `⏱️ Polling başlatıldı - her ${CONFIG.pollingIntervalMs}ms taranıyor`);
    }

    // =========================================================================
    // OVERLAY PANEL (Durum göstergesi)
    // =========================================================================
    function createOverlayPanel() {
        if (!CONFIG.showOverlayPanel) return;

        // Stil ekle
        GM_addStyle(`
            #perculus-auto-panel {
                position: fixed;
                ${CONFIG.panelPosition.includes('bottom') ? 'bottom: 15px;' : 'top: 15px;'}
                ${CONFIG.panelPosition.includes('right') ? 'right: 15px;' : 'left: 15px;'}
                z-index: 2147483647;
                background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
                border: 1px solid rgba(79, 172, 254, 0.3);
                border-radius: 12px;
                padding: 0;
                font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
                color: #e0e0e0;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 15px rgba(79, 172, 254, 0.1);
                min-width: 260px;
                max-width: 320px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
                user-select: none;
                backdrop-filter: blur(10px);
                overflow: hidden;
            }

            #perculus-auto-panel.minimized {
                min-width: auto;
                max-width: auto;
                padding: 0;
            }

            #perculus-auto-panel:hover {
                border-color: rgba(79, 172, 254, 0.6);
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5), 0 0 25px rgba(79, 172, 254, 0.2);
            }

            #perculus-auto-panel .panel-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                padding: 10px 14px;
                background: rgba(255, 255, 255, 0.03);
                border-bottom: 1px solid rgba(255, 255, 255, 0.06);
                cursor: move;
            }

            #perculus-auto-panel .panel-header .title {
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 0.5px;
                color: #4facfe;
                display: flex;
                align-items: center;
                gap: 6px;
            }

            #perculus-auto-panel .panel-header .controls {
                display: flex;
                gap: 6px;
                align-items: center;
            }

            #perculus-auto-panel .panel-header .controls button {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.1);
                color: #aaa;
                width: 24px;
                height: 24px;
                border-radius: 6px;
                cursor: pointer;
                font-size: 11px;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: all 0.2s;
                padding: 0;
            }

            #perculus-auto-panel .panel-header .controls button:hover {
                background: rgba(79, 172, 254, 0.2);
                color: #fff;
                border-color: rgba(79, 172, 254, 0.4);
            }

            #perculus-auto-panel .panel-body {
                padding: 12px 14px;
            }

            #perculus-auto-panel .panel-body.hidden {
                display: none;
            }

            #perculus-auto-panel .stat-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 4px 0;
                font-size: 11px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
            }

            #perculus-auto-panel .stat-row:last-child {
                border-bottom: none;
            }

            #perculus-auto-panel .stat-label {
                color: #888;
                font-weight: 500;
            }

            #perculus-auto-panel .stat-value {
                color: #e0e0e0;
                font-weight: 600;
                font-variant-numeric: tabular-nums;
            }

            #perculus-auto-panel .stat-value.success {
                color: #4caf50;
            }

            #perculus-auto-panel .stat-value.active {
                color: #4facfe;
            }

            #perculus-auto-panel .stat-value.warning {
                color: #ff9800;
            }

            #perculus-auto-panel .status-indicator {
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                margin-right: 2px;
                animation: pulse-dot 2s infinite;
            }

            #perculus-auto-panel .status-indicator.active {
                background: #4caf50;
                box-shadow: 0 0 6px rgba(76, 175, 80, 0.5);
            }

            #perculus-auto-panel .status-indicator.paused {
                background: #ff9800;
                box-shadow: 0 0 6px rgba(255, 152, 0, 0.5);
                animation: none;
            }

            @keyframes pulse-dot {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.5; transform: scale(0.85); }
            }

            #perculus-auto-panel .toggle-btn {
                width: 100%;
                padding: 8px;
                margin-top: 8px;
                border: 1px solid rgba(79, 172, 254, 0.3);
                border-radius: 8px;
                font-size: 11px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.2s;
                text-transform: uppercase;
                letter-spacing: 1px;
            }

            #perculus-auto-panel .toggle-btn.active {
                background: rgba(76, 175, 80, 0.15);
                color: #4caf50;
                border-color: rgba(76, 175, 80, 0.3);
            }

            #perculus-auto-panel .toggle-btn.active:hover {
                background: rgba(76, 175, 80, 0.25);
            }

            #perculus-auto-panel .toggle-btn.paused {
                background: rgba(255, 152, 0, 0.15);
                color: #ff9800;
                border-color: rgba(255, 152, 0, 0.3);
            }

            #perculus-auto-panel .toggle-btn.paused:hover {
                background: rgba(255, 152, 0, 0.25);
            }

            #perculus-auto-panel .recent-list {
                max-height: 80px;
                overflow-y: auto;
                margin-top: 6px;
                padding: 0;
            }

            #perculus-auto-panel .recent-item {
                font-size: 10px;
                color: #777;
                padding: 2px 0;
                display: flex;
                justify-content: space-between;
            }

            #perculus-auto-panel .recent-item .time {
                color: #4facfe;
                font-weight: 500;
            }
        `);

        const panel = document.createElement('div');
        panel.id = 'perculus-auto-panel';
        panel.innerHTML = `
            <div class="panel-header">
                <div class="title">
                    <span class="status-indicator active" id="pap-status-dot"></span>
                    YOKLAMA OTO-CLICKER
                </div>
                <div class="controls">
                    <button id="pap-minimize" title="Küçült/Büyüt">─</button>
                    <button id="pap-close" title="Kapat">✕</button>
                </div>
            </div>
            <div class="panel-body" id="pap-body">
                <div class="stat-row">
                    <span class="stat-label">Durum</span>
                    <span class="stat-value active" id="pap-status">AKTİF</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Toplam Tıklama</span>
                    <span class="stat-value success" id="pap-clicks">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Son Tıklama</span>
                    <span class="stat-value" id="pap-last">-</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Tarama Sayısı</span>
                    <span class="stat-value" id="pap-scans">0</span>
                </div>
                <div class="stat-row">
                    <span class="stat-label">Çalışma Süresi</span>
                    <span class="stat-value" id="pap-uptime">0dk</span>
                </div>
                <div class="recent-list" id="pap-recent"></div>
                <button class="toggle-btn active" id="pap-toggle">⏸️ DURAKLAT</button>
            </div>
        `;

        document.body.appendChild(panel);

        // Event listeners
        document.getElementById('pap-toggle').addEventListener('click', toggleActive);
        document.getElementById('pap-minimize').addEventListener('click', toggleMinimize);
        document.getElementById('pap-close').addEventListener('click', () => {
            panel.style.display = 'none';
        });

        // Panel sürükleme
        makeDraggable(panel);

        // Uptime timer
        setInterval(updateUptime, 30000);
        updateUptime();

        log('info', '📊 Overlay panel oluşturuldu');
    }

    function toggleActive() {
        STATE.isActive = !STATE.isActive;
        const btn = document.getElementById('pap-toggle');
        const statusDot = document.getElementById('pap-status-dot');
        const statusText = document.getElementById('pap-status');

        if (STATE.isActive) {
            btn.className = 'toggle-btn active';
            btn.textContent = '⏸️ DURAKLAT';
            statusDot.className = 'status-indicator active';
            statusText.textContent = 'AKTİF';
            statusText.className = 'stat-value active';
            log('info', '▶️ Otomatik tıklama devam ettiriliyor');
        } else {
            btn.className = 'toggle-btn paused';
            btn.textContent = '▶️ DEVAM ET';
            statusDot.className = 'status-indicator paused';
            statusText.textContent = 'DURAKLATILDI';
            statusText.className = 'stat-value warning';
            log('info', '⏸️ Otomatik tıklama duraklatıldı');
        }
    }

    function toggleMinimize() {
        const body = document.getElementById('pap-body');
        const btn = document.getElementById('pap-minimize');
        body.classList.toggle('hidden');
        btn.textContent = body.classList.contains('hidden') ? '☐' : '─';
    }

    function updateOverlayPanel() {
        const clicksEl = document.getElementById('pap-clicks');
        const lastEl = document.getElementById('pap-last');
        const scansEl = document.getElementById('pap-scans');
        const recentEl = document.getElementById('pap-recent');

        if (clicksEl) clicksEl.textContent = STATE.totalClicks.toString();
        // Panel içinde literal hedef kelime geçmesin diye sanitize et (kısır döngüyü önleme garantisi)
        const safeText = (text) => (text || '-').replace(/buradayım/gi, 'B***dayım').replace(/burdayım/gi, 'B**dayım');
        if (lastEl) lastEl.textContent = safeText(STATE.lastClickedText);
        if (scansEl) scansEl.textContent = STATE.scanCount.toString();

        if (recentEl && STATE.recentClicks.length > 0) {
            recentEl.innerHTML = STATE.recentClicks.slice(-5).reverse().map(c =>
                `<div class="recent-item"><span class="time">${c.time}</span><span>${safeText(c.text)}</span></div>`
            ).join('');
        }
    }

    function updateUptime() {
        const uptimeEl = document.getElementById('pap-uptime');
        if (!uptimeEl) return;
        const elapsed = Math.floor((Date.now() - STATE.startTime) / 60000);
        if (elapsed < 60) {
            uptimeEl.textContent = `${elapsed}dk`;
        } else {
            const hours = Math.floor(elapsed / 60);
            const mins = elapsed % 60;
            uptimeEl.textContent = `${hours}sa ${mins}dk`;
        }

        // Scan count da güncelle
        const scansEl = document.getElementById('pap-scans');
        if (scansEl) scansEl.textContent = STATE.scanCount.toString();
    }

    function makeDraggable(element) {
        const header = element.querySelector('.panel-header');
        let isDragging = false;
        let offsetX, offsetY;

        header.addEventListener('mousedown', (e) => {
            if (e.target.tagName === 'BUTTON') return;
            isDragging = true;
            const rect = element.getBoundingClientRect();
            offsetX = e.clientX - rect.left;
            offsetY = e.clientY - rect.top;
            element.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault();
            const x = e.clientX - offsetX;
            const y = e.clientY - offsetY;

            element.style.left = x + 'px';
            element.style.top = y + 'px';
            element.style.right = 'auto';
            element.style.bottom = 'auto';
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                element.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
            }
        });
    }

    // =========================================================================
    // KEYBOARD SHORTCUT
    // =========================================================================
    function setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            // Ctrl+Shift+B = Toggle aktif/pasif
            if (e.ctrlKey && e.shiftKey && e.key === 'B') {
                e.preventDefault();
                toggleActive();
                log('info', `Klavye kısayolu: ${STATE.isActive ? 'AKTİF' : 'DURAKLATILDI'}`);
            }

            // Ctrl+Shift+M = Manuel tarama tetikle
            if (e.ctrlKey && e.shiftKey && e.key === 'M') {
                e.preventDefault();
                STATE.lastClickTime = 0; // Cooldown'ı sıfırla
                processAttendanceButtons();
                log('info', 'Klavye kısayolu: Manuel tarama tetiklendi');
            }
        });

        log('info', '⌨️ Kısayollar: Ctrl+Shift+B (Aç/Kapa), Ctrl+Shift+M (Manuel Tara)');
    }

    // =========================================================================
    // INITIALIZATION
    // =========================================================================
    function init() {
        log('info', '🚀 ═══════════════════════════════════════════');
        log('info', '🚀 Perculus Otomatik Yoklama Sistemi v2.0');
        log('info', '🚀 ═══════════════════════════════════════════');
        log('info', `📋 İzlenen metin sayısı: ${CONFIG.buttonTexts.length}`);
        log('info', `⏱️ Polling aralığı: ${CONFIG.pollingIntervalMs}ms`);
        log('info', `🕐 Observer debounce: ${CONFIG.observerDebounceMs}ms`);
        log('info', `❄️ Tıklama cooldown: ${CONFIG.clickCooldownMs}ms`);

        // Sayfa yüklenmesini bekle
        const waitForBody = () => {
            if (document.body) {
                // Sistemi başlat
                createOverlayPanel();
                startMutationObserver();
                startPolling();
                setupKeyboardShortcuts();

                // İlk taramayı hemen yap
                setTimeout(() => {
                    processAttendanceButtons();
                }, 1000);

                // İkinci tarama (React render'ı geç olabilir)
                setTimeout(() => {
                    processAttendanceButtons();
                }, 3000);

                // Üçüncü tarama
                setTimeout(() => {
                    processAttendanceButtons();
                }, 5000);

                log('info', '✅ Sistem hazır - yoklama butonları izleniyor');
                notify('🟢 Yoklama Sistemi Aktif', 'Otomatik "Buradayım" tıklayıcı çalışıyor.');
            } else {
                setTimeout(waitForBody, 100);
            }
        };

        waitForBody();
    }

    // =========================================================================
    // SPA URL CHANGE DETECTION (Perculus SPA desteği)
    // =========================================================================
    function setupSPADetection() {
        let lastUrl = location.href;

        // Yöntem 1: window.onurlchange (modern browsers + Tampermonkey)
        if (window.onurlchange === null) {
            window.addEventListener('urlchange', (info) => {
                log('info', '🔄 SPA URL değişti:', info.url);
                setTimeout(() => processAttendanceButtons(), 500);
                setTimeout(() => processAttendanceButtons(), 2000);
            });
            log('info', '🔄 window.onurlchange SPA dedektörü aktif');
        }

        // Yöntem 2: history.pushState / replaceState override
        const originalPushState = history.pushState;
        const originalReplaceState = history.replaceState;

        history.pushState = function (...args) {
            originalPushState.apply(this, args);
            log('debug', '🔄 pushState algılandı');
            setTimeout(() => processAttendanceButtons(), 500);
            setTimeout(() => processAttendanceButtons(), 2000);
        };

        history.replaceState = function (...args) {
            originalReplaceState.apply(this, args);
            log('debug', '🔄 replaceState algılandı');
            setTimeout(() => processAttendanceButtons(), 500);
        };

        // Yöntem 3: popstate event
        window.addEventListener('popstate', () => {
            log('debug', '🔄 popstate algılandı');
            setTimeout(() => processAttendanceButtons(), 500);
        });

        // Yöntem 4: URL polling (en son çare)
        setInterval(() => {
            if (location.href !== lastUrl) {
                lastUrl = location.href;
                log('info', '🔄 URL değişikliği algılandı (polling):', lastUrl);
                setTimeout(() => processAttendanceButtons(), 500);
                setTimeout(() => processAttendanceButtons(), 2000);
            }
        }, 1000);

        log('info', '🔄 SPA navigasyon dedektörleri aktif (4 yöntem)');
    }

    // =========================================================================
    // KEY SİSTEMİ
    // =========================================================================
    const KEY_CONFIG = {
        url: 'https://raw.githubusercontent.com/lolxdman03/keys/refs/heads/main/keys.json',
        storageKey: 'perculus_license_key',
        lastOkKey: 'perculus_license_last_ok',
        offlineGraceMs: 24 * 60 * 60 * 1000, // GitHub'a ulaşılamazsa son başarılı doğrulamadan sonra 24 saat devam et
        timeoutMs: 10000,
    };

    function fetchKeyList() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `${KEY_CONFIG.url}?t=${Date.now()}`,
                timeout: KEY_CONFIG.timeoutMs,
                headers: { 'Cache-Control': 'no-cache' },
                onload: (res) => {
                    if (res.status < 200 || res.status >= 300) {
                        return reject(new Error('HTTP ' + res.status));
                    }
                    try {
                        resolve(JSON.parse(res.responseText));
                    } catch (e) {
                        reject(new Error('JSON okunamadı'));
                    }
                },
                onerror: () => reject(new Error('Ağ hatası')),
                ontimeout: () => reject(new Error('Zaman aşımı')),
            });
        });
    }

    // Dönüş: { ok: true } | { ok: false, reason: '...', network?: true }
    async function validateKey(key) {
        let data;
        try {
            data = await fetchKeyList();
        } catch (e) {
            return { ok: false, network: true, reason: 'Key sunucusuna ulaşılamadı (' + e.message + ')' };
        }
        const entry = data && data.keys && data.keys[key];
        if (!entry) return { ok: false, reason: 'Geçersiz key' };
        if (entry.active === false) return { ok: false, reason: 'Bu key devre dışı' };
        if (entry.expires) {
            const exp = new Date(entry.expires + 'T23:59:59');
            if (!isNaN(exp) && Date.now() > exp.getTime()) {
                return { ok: false, reason: 'Key süresi dolmuş (' + entry.expires + ')' };
            }
        }
        return { ok: true };
    }

    function showKeyPrompt(message) {
        return new Promise((resolve) => {
            const build = () => {
                if (!document.body) return setTimeout(build, 100);

                const old = document.getElementById('perculus-key-overlay');
                if (old) old.remove();

                const overlay = document.createElement('div');
                overlay.id = 'perculus-key-overlay';
                // Sayfayı ENGELLEMEZ: sadece sol altta küçük kart, arka plan/perde yok
                overlay.style.cssText =
                    'position:fixed;left:16px;bottom:16px;z-index:2147483647;pointer-events:none;' +
                    'font-family:system-ui,Segoe UI,Arial,sans-serif;';

                const box = document.createElement('div');
                box.style.cssText =
                    'pointer-events:auto;position:relative;background:#1e1e2e;color:#fff;padding:16px;border-radius:12px;width:260px;' +
                    'box-shadow:0 6px 24px rgba(0,0,0,.45);text-align:center;';

                const title = document.createElement('div');
                title.textContent = '🔑 Perculus Yoklama - Key Gerekli';
                title.style.cssText = 'font-size:14px;font-weight:600;margin-bottom:8px;';

                const msg = document.createElement('div');
                msg.textContent = message || 'Yoklama otomasyonu için key gir (bir kez yeterli).';
                msg.style.cssText = 'font-size:13px;opacity:.85;margin-bottom:10px;' + (message ? 'color:#ff8a8a;opacity:1;' : '');

                const input = document.createElement('input');
                input.type = 'text';
                input.placeholder = 'Key';
                input.autocomplete = 'off';
                input.style.cssText =
                    'width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #444;' +
                    'background:#11111b;color:#fff;font-size:14px;margin-bottom:12px;outline:none;';

                const btn = document.createElement('button');
                btn.textContent = 'Doğrula';
                btn.style.cssText =
                    'width:100%;padding:10px;border:0;border-radius:8px;background:#4caf50;color:#fff;' +
                    'font-size:14px;font-weight:600;cursor:pointer;';

                const submit = () => {
                    const val = input.value.trim();
                    if (!val) return;
                    overlay.remove();
                    resolve(val);
                };
                btn.addEventListener('click', submit);
                input.addEventListener('keydown', (e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') submit();
                });

                const pill = document.createElement('button');
                pill.textContent = '🔑 Key gir';
                pill.style.cssText =
                    'pointer-events:auto;display:none;padding:8px 12px;border:0;border-radius:20px;background:#1e1e2e;' +
                    'color:#fff;font-size:12px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4);';

                const close = document.createElement('button');
                close.textContent = '✕';
                close.title = 'Küçült';
                close.style.cssText =
                    'position:absolute;top:6px;right:8px;background:none;border:0;color:#aaa;font-size:14px;cursor:pointer;';
                close.addEventListener('click', () => { box.style.display = 'none'; pill.style.display = 'block'; });
                pill.addEventListener('click', () => { pill.style.display = 'none'; box.style.display = 'block'; input.focus(); });

                box.append(close, title, msg, input, btn);
                overlay.append(box, pill);
                document.body.appendChild(overlay);
                input.focus();
            };
            build();
        });
    }

    // Key kapısı: geçerli key bulunursa true döner. Kayıtlı key varsa sormaz.
    async function ensureLicensed(isTopFrame) {
        let key = GM_getValue(KEY_CONFIG.storageKey, '');

        if (key) {
            const r = await validateKey(key);
            if (r.ok) {
                GM_setValue(KEY_CONFIG.lastOkKey, Date.now());
                return true;
            }
            if (r.network) {
                // İnternet/GitHub sorunu: daha önce doğrulanmışsa kullanıcıyı bekletme
                const lastOk = GM_getValue(KEY_CONFIG.lastOkKey, 0);
                if (Date.now() - lastOk < KEY_CONFIG.offlineGraceMs) {
                    log('warn', '⚠️ Key sunucusuna ulaşılamadı, kayıtlı doğrulama ile devam ediliyor');
                    return true;
                }
            }
            // Key artık geçerli değil
            GM_deleteValue(KEY_CONFIG.storageKey);
            if (!isTopFrame) return false;
            return promptLoop(r.reason);
        }

        if (!isTopFrame) return false;
        return promptLoop();
    }

    async function promptLoop(message) {
        for (;;) {
            const entered = await showKeyPrompt(message);
            const r = await validateKey(entered);
            if (r.ok) {
                GM_setValue(KEY_CONFIG.storageKey, entered);
                GM_setValue(KEY_CONFIG.lastOkKey, Date.now());
                notify('🔑 Key Doğrulandı', 'Sistem aktif. Bir daha key sorulmayacak.');
                return true;
            }
            message = r.reason;
        }
    }

    // Ctrl+Shift+K: kayıtlı key'i sil ve yeniden sor
    function setupKeyReset() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.shiftKey && (e.key === 'K' || e.key === 'k') && window === window.top) {
                e.preventDefault();
                GM_deleteValue(KEY_CONFIG.storageKey);
                location.reload();
            }
        });
    }

    let started = false;
    function startAll() {
        if (started) return;
        started = true;
        init();
        setupSPADetection();
    }

    async function boot() {
        const isTop = window === window.top;
        setupKeyReset();

        if (await ensureLicensed(isTop)) {
            startAll();
            return;
        }

        // Alt frame'ler: key üst sayfada girilene kadar bekle
        const wait = setInterval(async () => {
            if (GM_getValue(KEY_CONFIG.storageKey, '') && await ensureLicensed(false)) {
                clearInterval(wait);
                startAll();
            }
        }, 3000);
    }

    // Başlat
    boot();

})();
