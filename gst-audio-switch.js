(function () {
    'use strict';

    /**
     * GST Audio Switch for Lampa
     * Реальная смена озвучки во встроенном плеере при TorrServer-gst (HLS).
     *
     * Проблема: Лампа всегда открывает /gst/.../master.m3u8?audio=0, а HLS содержит
     * одну дорожку. Меню «Аудиодорожки» показывает метаданные, но звук не меняется.
     *
     * Решение: при выборе дорожки перезапускаем поток с нужным audio=N
     * (как делает Лампа при смене качества) и возвращаемся на текущее время.
     */

    var VERSION = '1.0.0';
    var NAME = 'GST Audio Switch';
    var LOG_PREFIX = '[GST-Audio]';
    var STORAGE_PREF = 'gst_audio_switch_pref';
    var STORAGE_DEBUG = 'gst_audio_switch_debug';

    var state = {
        active: false,
        switching: false,
        hash: '',
        fileIndex: '',
        baseUrl: '',
        audioIndex: 0,
        tracks: [],
        applyTimer: null,
        seekTimer: null,
        lastNotyAt: 0
    };

    function debugEnabled() {
        try {
            return Lampa.Storage.get(STORAGE_DEBUG, 'false') === true
                || Lampa.Storage.get(STORAGE_DEBUG, 'false') === 'true';
        } catch (e) {
            return false;
        }
    }

    function log() {
        if (!debugEnabled()) return;
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function notify(text) {
        var now = Date.now();
        if (now - state.lastNotyAt < 700) return;
        state.lastNotyAt = now;
        try {
            if (Lampa.Noty && Lampa.Noty.show) Lampa.Noty.show(text);
        } catch (e) {}
    }

    function safe(label, fn) {
        return function () {
            try {
                return fn.apply(this, arguments);
            } catch (e) {
                log('error in ' + label, e && e.message ? e.message : e);
            }
        };
    }

    function isGstUrl(url) {
        return typeof url === 'string' && /\/gst\/[^/]+\/master\.m3u8/i.test(url);
    }

    function parseGstUrl(url) {
        if (!isGstUrl(url)) return null;

        var match = url.match(/^(https?:\/\/[^/]+)\/gst\/([^/?#]+)\/master\.m3u8\?(.*)$/i);
        if (!match) return null;

        var query = {};
        String(match[3] || '').split('&').forEach(function (part) {
            if (!part) return;
            var kv = part.split('=');
            var key = decodeURIComponent(kv[0] || '');
            var val = decodeURIComponent(kv.slice(1).join('=') || '');
            if (key) query[key] = val;
        });

        var fileIndex = query.index || query.id || query.fileID || '';
        var audio = parseInt(query.audio, 10);
        if (isNaN(audio) || audio < 0) audio = 0;

        return {
            origin: match[1],
            hash: decodeURIComponent(match[2]),
            fileIndex: String(fileIndex),
            audio: audio,
            query: query,
            url: url
        };
    }

    function buildGstUrl(parsed, audioIndex, seconds) {
        var params = [];
        var fileKey = parsed.query.index !== undefined ? 'index'
            : parsed.query.id !== undefined ? 'id'
            : parsed.query.fileID !== undefined ? 'fileID'
            : 'index';

        params.push(encodeURIComponent(fileKey) + '=' + encodeURIComponent(parsed.fileIndex));
        params.push('audio=' + encodeURIComponent(String(audioIndex)));

        if (typeof seconds === 'number' && isFinite(seconds) && seconds > 1) {
            params.push('seconds=' + encodeURIComponent(String(Math.floor(seconds))));
        }

        return parsed.origin + '/gst/' + encodeURIComponent(parsed.hash) + '/master.m3u8?' + params.join('&');
    }

    function getPlaydata() {
        try {
            if (Lampa.Player && typeof Lampa.Player.playdata === 'function') {
                return Lampa.Player.playdata() || null;
            }
        } catch (e) {}
        return null;
    }

    function getVideo() {
        try {
            if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.video === 'function') {
                return Lampa.PlayerVideo.video();
            }
        } catch (e) {}
        return null;
    }

    function toPlayUrl(url) {
        try {
            if (Lampa.Torserver && typeof Lampa.Torserver.toPlayUrl === 'function') {
                return Lampa.Torserver.toPlayUrl(url);
            }
        } catch (e) {}
        return url;
    }

    function currentPosition() {
        var video = getVideo();
        var work = getPlaydata();
        var time = 0;
        var duration = 0;

        if (video) {
            if (isFinite(video.currentTime)) time = video.currentTime;
            if (isFinite(video.duration)) duration = video.duration;
        }

        if ((!time || time < 1) && work && work.timeline && isFinite(work.timeline.time)) {
            time = work.timeline.time;
        }

        if ((!duration || duration < 1) && work && work.timeline && isFinite(work.timeline.duration)) {
            duration = work.timeline.duration;
        }

        return {
            time: Math.max(0, time || 0),
            duration: Math.max(0, duration || 0)
        };
    }

    function updateTimeline(time, duration) {
        var work = getPlaydata();
        if (!work) return;

        if (!work.timeline || typeof work.timeline !== 'object') {
            work.timeline = {
                percent: 0,
                time: 0,
                duration: 0
            };
        }

        work.timeline.time = Math.max(0, time || 0);
        if (duration > 0) {
            work.timeline.duration = duration;
            work.timeline.percent = Math.max(0, Math.min(99, Math.round((time / duration) * 100)));
        } else if (work.timeline.duration > 0) {
            work.timeline.percent = Math.max(0, Math.min(99, Math.round((time / work.timeline.duration) * 100)));
        }

        // Как при смене качества: сбрасываем флаг продолжения, чтобы плеер сам seek-нул.
        work.timeline.continued = false;
        work.timeline.continued_bloc = false;
        work.timeline.waiting_for_user = false;
    }

    function loadPrefs() {
        try {
            var pref = Lampa.Storage.get(STORAGE_PREF, {});
            return pref && typeof pref === 'object' ? pref : {};
        } catch (e) {
            return {};
        }
    }

    function savePref(track) {
        if (!track) return;
        try {
            Lampa.Storage.set(STORAGE_PREF, {
                language: (track.language || '').toLowerCase(),
                label: track.label || '',
                updated: Date.now()
            });
        } catch (e) {}
    }

    function scoreTrack(track, pref) {
        if (!pref) return 0;
        var score = 0;
        var lang = (track.language || '').toLowerCase();
        var label = (track.label || '').toLowerCase();
        var prefLang = (pref.language || '').toLowerCase();
        var prefLabel = (pref.label || '').toLowerCase();

        if (prefLabel && label && label === prefLabel) score += 100;
        else if (prefLabel && label && label.indexOf(prefLabel) >= 0) score += 60;
        else if (prefLabel && label && prefLabel.indexOf(label) >= 0) score += 40;

        if (prefLang && lang && lang === prefLang) score += 20;

        return score;
    }

    function pickPreferredIndex(tracks) {
        var pref = loadPrefs();
        if (!tracks || !tracks.length || !pref || (!pref.label && !pref.language)) return 0;

        var best = 0;
        var bestScore = 0;

        tracks.forEach(function (track, i) {
            var score = scoreTrack(track, pref);
            if (score > bestScore) {
                bestScore = score;
                best = i;
            }
        });

        return bestScore >= 20 ? best : 0;
    }

    function codecShort(capsName, codec) {
        var src = String(capsName || codec || '').toLowerCase();
        if (src.indexOf('eac3') >= 0 || src.indexOf('e-ac3') >= 0) return 'E-AC3';
        if (src.indexOf('ac3') >= 0) return 'AC3';
        if (src.indexOf('aac') >= 0 || src.indexOf('mpeg') >= 0) return 'AAC';
        if (src.indexOf('dts') >= 0) return 'DTS';
        if (src.indexOf('truehd') >= 0) return 'TrueHD';
        if (src.indexOf('opus') >= 0) return 'Opus';
        if (src.indexOf('vorbis') >= 0) return 'Vorbis';
        return '';
    }

    function channelsLabel(channels) {
        var n = parseInt(channels, 10);
        if (!n || n < 1) return '';
        if (n === 1) return '1.0';
        if (n === 2) return '2.0';
        if (n === 6) return '5.1';
        if (n === 8) return '7.1';
        return String(n) + 'ch';
    }

    function normalizeAudioTracks(probeTracks) {
        var list = [];
        (probeTracks || []).forEach(function (track) {
            if (!track || String(track.Type || '').toLowerCase() !== 'audio') return;

            var index = parseInt(track.Index, 10);
            if (isNaN(index) || index < 0) return;

            list.push({
                index: index,
                language: track.Language || '',
                label: track.Title || '',
                channels: track.Channels || 0,
                rate: track.Rate || 0,
                codec: codecShort(track.CapsName, track.Codec),
                padName: track.PadName || ''
            });
        });

        list.sort(function (a, b) { return a.index - b.index; });
        return list;
    }

    function requestProbe(parsed, callback) {
        var url = parsed.origin + '/gst/' + encodeURIComponent(parsed.hash)
            + '/probe?index=' + encodeURIComponent(parsed.fileIndex);

        log('probe', url);

        function done(json) {
            if (json && json.Tracks) callback(null, json);
            else callback(new Error('probe failed'));
        }

        function tryNative() {
            var net = new Lampa.Reguest();
            net.timeout(20000);
            net.native(url, function (str) {
                var json = str;
                if (typeof str === 'string') {
                    try { json = JSON.parse(str); } catch (e) { json = null; }
                }
                done(json);
            }, function () {
                callback(new Error('probe failed'));
            }, false, { dataType: 'text' });
        }

        var net = new Lampa.Reguest();
        net.timeout(20000);
        net.silent(url, function (json) {
            if (json && json.Tracks) done(json);
            else tryNative();
        }, function () {
            tryNative();
        });
    }

    function makePanelTrack(meta, selected) {
        return {
            index: meta.index,
            language: meta.language || 'und',
            label: meta.label || '',
            selected: !!selected,
            enabled: !!selected,
            ghost: false,
            extra: {
                channels: channelsLabel(meta.channels),
                fourCC: meta.codec || ''
            },
            // Панель плеера вызывает onSelect после выбора пункта меню.
            onSelect: safe('onSelect', function () {
                switchToAudio(meta.index, meta);
            })
        };
    }

    function applyTracksToPanel(force) {
        if (!state.active || !state.tracks.length) return;
        if (state.switching && !force) return;

        var panelTracks = state.tracks.map(function (meta) {
            return makePanelTrack(meta, meta.index === state.audioIndex);
        });

        if (Lampa.PlayerPanel && typeof Lampa.PlayerPanel.setTracks === 'function') {
            Lampa.PlayerPanel.setTracks(panelTracks);
            log('tracks applied', panelTracks.length, 'selected', state.audioIndex);
        }
    }

    function scheduleApplyTracks() {
        clearTimeout(state.applyTimer);
        // Перебиваем Tracks/MediaInfo, которые подменяют список чуть позже.
        var delays = [0, 250, 800, 1800, 3500];
        delays.forEach(function (ms, i) {
            setTimeout(safe('delayedApply#' + i, function () {
                if (state.active) applyTracksToPanel(false);
            }), ms);
        });
    }

    function seekAfterReady(targetTime) {
        clearTimeout(state.seekTimer);
        if (!targetTime || targetTime < 3) return;

        var attempts = 0;
        var maxAttempts = 40;

        function trySeek() {
            attempts += 1;
            var video = getVideo();
            if (!video) {
                if (attempts < maxAttempts) state.seekTimer = setTimeout(trySeek, 250);
                return;
            }

            var duration = video.duration || 0;
            var ready = video.readyState >= 1 || (duration && isFinite(duration));

            if (!ready) {
                if (attempts < maxAttempts) state.seekTimer = setTimeout(trySeek, 250);
                return;
            }

            var posit = targetTime;
            if (duration > 20) {
                var maxPos = duration - 15;
                if (posit > maxPos) posit = maxPos;
            }

            try {
                if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.to === 'function') {
                    Lampa.PlayerVideo.to(posit);
                } else {
                    video.currentTime = posit;
                }
                log('seek to', posit);
            } catch (e) {
                log('seek failed', e && e.message);
            }
        }

        state.seekTimer = setTimeout(trySeek, 400);
    }

    function switchToAudio(audioIndex, meta) {
        if (!state.active || state.switching) return;

        audioIndex = parseInt(audioIndex, 10);
        if (isNaN(audioIndex) || audioIndex < 0) return;
        if (audioIndex === state.audioIndex) {
            applyTracksToPanel(true);
            return;
        }

        var work = getPlaydata();
        if (!work || !isGstUrl(work.url)) {
            notify('GST Audio: поток не gst/HLS');
            return;
        }

        var parsed = parseGstUrl(work.url);
        if (!parsed) {
            notify('GST Audio: не удалось разобрать URL');
            return;
        }

        var pos = currentPosition();
        var nextUrl = buildGstUrl(parsed, audioIndex, pos.time);

        log('switch', state.audioIndex, '->', audioIndex, 'at', pos.time, nextUrl);

        state.switching = true;
        state.audioIndex = audioIndex;
        savePref(meta || state.tracks.filter(function (t) { return t.index === audioIndex; })[0]);

        updateTimeline(pos.time, pos.duration);
        work.url = nextUrl;
        work.gst_audio = audioIndex;

        var label = (meta && (meta.label || meta.language)) || ('#' + (audioIndex + 1));
        notify('Озвучка: ' + label);

        try {
            if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.destroy === 'function') {
                Lampa.PlayerVideo.destroy(true);
            }
            if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.url === 'function') {
                Lampa.PlayerVideo.url(toPlayUrl(nextUrl), true);
            } else {
                throw new Error('PlayerVideo.url unavailable');
            }
        } catch (e) {
            state.switching = false;
            log('switch failed', e && e.message);
            notify('GST Audio: ошибка переключения');
            return;
        }

        applyTracksToPanel(true);
        seekAfterReady(pos.time);

        setTimeout(safe('unlockSwitch', function () {
            state.switching = false;
            scheduleApplyTracks();
        }), 1200);
    }

    function maybeAutoselect(parsed) {
        if (!state.tracks.length) return;

        var preferred = pickPreferredIndex(state.tracks);
        if (preferred === state.audioIndex) return;
        if (preferred === parsed.audio) {
            state.audioIndex = preferred;
            return;
        }

        // Автовыбор только если пользователь уже сохранял предпочтение.
        var pref = loadPrefs();
        if (!pref || (!pref.label && !pref.language)) return;

        var track = state.tracks[preferred];
        if (!track) return;

        log('autoselect', preferred, track.label || track.language);
        setTimeout(safe('autoselect', function () {
            if (state.active && !state.switching) switchToAudio(track.index, track);
        }), 600);
    }

    function resetState() {
        clearTimeout(state.applyTimer);
        clearTimeout(state.seekTimer);
        state.active = false;
        state.switching = false;
        state.hash = '';
        state.fileIndex = '';
        state.baseUrl = '';
        state.audioIndex = 0;
        state.tracks = [];
    }

    function onPlayerStart(data) {
        resetState();

        if (!data || !isGstUrl(data.url)) {
            log('skip: not gst url');
            return;
        }

        var parsed = parseGstUrl(data.url);
        if (!parsed || !parsed.hash || !parsed.fileIndex) {
            log('skip: bad gst url', data.url);
            return;
        }

        state.active = true;
        state.hash = parsed.hash;
        state.fileIndex = parsed.fileIndex;
        state.baseUrl = parsed.origin;
        state.audioIndex = parsed.audio;

        log('start', parsed.hash, 'file', parsed.fileIndex, 'audio', parsed.audio);

        requestProbe(parsed, safe('probeCallback', function (err, json) {
            if (!state.active) return;

            if (err || !json || !json.Tracks) {
                log('probe error', err && err.message);
                notify('GST Audio: не удалось получить дорожки');
                return;
            }

            state.tracks = normalizeAudioTracks(json.Tracks);
            if (state.tracks.length < 2) {
                log('only one audio track, nothing to switch');
                if (state.tracks.length === 1) applyTracksToPanel(true);
                return;
            }

            applyTracksToPanel(true);
            scheduleApplyTracks();
            maybeAutoselect(parsed);
        }));
    }

    function onPlayerDestroy() {
        log('destroy');
        resetState();
    }

    function onVideoTracks() {
        if (!state.active || state.switching) return;
        // HLS обычно отдаёт 1 дорожку — возвращаем полный список из probe.
        scheduleApplyTracks();
    }

    function onCanPlay() {
        if (!state.active || state.switching) return;
        scheduleApplyTracks();
    }

    function bind() {
        if (!window.Lampa || !Lampa.Player || !Lampa.Player.listener) {
            setTimeout(bind, 500);
            return;
        }

        Lampa.Player.listener.follow('start', safe('start', onPlayerStart));
        Lampa.Player.listener.follow('destroy', safe('destroy', onPlayerDestroy));
        Lampa.Player.listener.follow('ready', safe('ready', function () {
            if (state.active) scheduleApplyTracks();
        }));

        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('tracks', safe('tracks', onVideoTracks));
            Lampa.PlayerVideo.listener.follow('canplay', safe('canplay', onCanPlay));
        }

        try {
            console.log(LOG_PREFIX, 'loaded v' + VERSION);
        } catch (e) {}
    }

    if (!window.gst_audio_switch_loaded) {
        window.gst_audio_switch_loaded = true;
        bind();
    }
})();
