(function () {
    'use strict';

    /**
     * GST Audio Switch for Lampa + TorrServer-gst
     * Меняет озвучку перезапуском HLS с нужным audio=N.
     */
    var VERSION = '1.0.3';
    var LOG = '[GST-Audio]';
    var PREF_KEY = 'gst_audio_switch_pref';
    var DEBUG_KEY = 'gst_audio_switch_debug';

    var state = {
        active: false,
        switching: false,
        audioIndex: 0,
        tracks: [],
        applyTimers: [],
        seekTimer: null,
        autoTimer: null,
        unlockTimer: null,
        lastNotyAt: 0,
        switchToken: 0
    };

    function debug() {
        try {
            var v = Lampa.Storage.get(DEBUG_KEY, false);
            return v === true || v === 'true';
        } catch (e) {
            return false;
        }
    }

    function log() {
        if (!debug()) return;
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG);
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

    function safe(fn) {
        return function () {
            try {
                return fn.apply(this, arguments);
            } catch (e) {
                log('error', e && e.message ? e.message : e);
            }
        };
    }

    function clearTimer(name) {
        if (state[name]) {
            clearTimeout(state[name]);
            state[name] = null;
        }
    }

    function clearApplyTimers() {
        state.applyTimers.forEach(clearTimeout);
        state.applyTimers = [];
    }

    function isGstUrl(url) {
        return typeof url === 'string' && /\/gst\/[^/]+\/master\.m3u8/i.test(url);
    }

    function parseQuery(qs) {
        var query = {};
        String(qs || '').split('&').forEach(function (part) {
            if (!part) return;
            var kv = part.split('=');
            var key = decodeURIComponent(kv[0] || '');
            if (!key) return;
            query[key] = decodeURIComponent(kv.slice(1).join('=') || '');
        });
        return query;
    }

    function parseGstUrl(url) {
        var match = String(url || '').match(/^(https?:\/\/[^/]+)\/gst\/([^/?#]+)\/master\.m3u8\?(.*)$/i);
        if (!match) return null;

        var query = parseQuery(match[3]);
        var audio = parseInt(query.audio, 10);

        return {
            origin: match[1],
            hash: decodeURIComponent(match[2]),
            fileIndex: String(query.index || query.id || query.fileID || ''),
            fileKey: query.index !== undefined ? 'index'
                : query.id !== undefined ? 'id'
                : query.fileID !== undefined ? 'fileID'
                : 'index',
            audio: isNaN(audio) || audio < 0 ? 0 : audio
        };
    }

    function buildGstUrl(parsed, audioIndex, seconds) {
        var params = [
            encodeURIComponent(parsed.fileKey) + '=' + encodeURIComponent(parsed.fileIndex),
            'audio=' + encodeURIComponent(String(audioIndex))
        ];

        if (typeof seconds === 'number' && isFinite(seconds) && seconds > 1) {
            params.push('seconds=' + Math.floor(seconds));
        }

        return parsed.origin + '/gst/' + encodeURIComponent(parsed.hash) + '/master.m3u8?' + params.join('&');
    }

    function playdata() {
        try {
            return Lampa.Player && typeof Lampa.Player.playdata === 'function'
                ? (Lampa.Player.playdata() || null)
                : null;
        } catch (e) {
            return null;
        }
    }

    function videoEl() {
        try {
            return Lampa.PlayerVideo && typeof Lampa.PlayerVideo.video === 'function'
                ? Lampa.PlayerVideo.video()
                : null;
        } catch (e) {
            return null;
        }
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
        var video = videoEl();
        var work = playdata();
        var time = video && isFinite(video.currentTime) ? video.currentTime : 0;
        var duration = video && isFinite(video.duration) ? video.duration : 0;

        if (time < 1 && work && work.timeline && isFinite(work.timeline.time)) {
            time = work.timeline.time;
        }
        if (duration < 1 && work && work.timeline && isFinite(work.timeline.duration)) {
            duration = work.timeline.duration;
        }

        return {
            time: Math.max(0, time || 0),
            duration: Math.max(0, duration || 0)
        };
    }

    function touchTimeline(time, duration, continued) {
        var work = playdata();
        if (!work) return;

        if (!work.timeline || typeof work.timeline !== 'object') {
            work.timeline = { percent: 0, time: 0, duration: 0 };
        }

        if (typeof time === 'number') {
            work.timeline.time = Math.max(0, time);
            var total = duration > 0 ? duration : work.timeline.duration;
            if (total > 0) {
                work.timeline.duration = total;
                work.timeline.percent = Math.max(0, Math.min(99, Math.round((work.timeline.time / total) * 100)));
            }
        }

        work.timeline.continued = !!continued;
        work.timeline.continued_bloc = !!continued;
        work.timeline.waiting_for_user = false;
    }

    function loadPref() {
        try {
            var pref = Lampa.Storage.get(PREF_KEY, {});
            return pref && typeof pref === 'object' ? pref : {};
        } catch (e) {
            return {};
        }
    }

    function savePref(track) {
        if (!track || !track.label) return;
        try {
            Lampa.Storage.set(PREF_KEY, {
                label: track.label,
                language: (track.language || '').toLowerCase(),
                updated: Date.now()
            });
        } catch (e) {}
    }

    function pickPreferredTrack(tracks) {
        var pref = loadPref();
        var want = (pref.label || '').toLowerCase();
        if (!want || !tracks || !tracks.length) return null;

        var exact = null;
        var partial = null;

        for (var i = 0; i < tracks.length; i++) {
            var label = (tracks[i].label || '').toLowerCase();
            if (!label) continue;
            if (label === want) {
                exact = tracks[i];
                break;
            }
            if (!partial && (label.indexOf(want) >= 0 || want.indexOf(label) >= 0)) {
                partial = tracks[i];
            }
        }

        return exact || partial;
    }

    function codecShort(capsName, codec) {
        var src = String(capsName || codec || '').toLowerCase();
        if (src.indexOf('eac3') >= 0 || src.indexOf('e-ac3') >= 0) return 'E-AC3';
        if (src.indexOf('ac3') >= 0) return 'AC3';
        if (src.indexOf('mp4a') >= 0 || src.indexOf('aac') >= 0) return 'AAC';
        if (src.indexOf('mp3') >= 0) return 'MP3';
        if (src.indexOf('dts') >= 0) return 'DTS';
        if (src.indexOf('truehd') >= 0) return 'TrueHD';
        if (src.indexOf('opus') >= 0) return 'Opus';
        return '';
    }

    function channelsLabel(channels) {
        var n = parseInt(channels, 10);
        if (!n || n < 1) return '';
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
                codec: codecShort(track.CapsName, track.Codec)
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
            callback(json && json.Tracks ? null : new Error('probe failed'), json);
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
        }, tryNative);
    }

    function selectOpened() {
        try {
            return !!(Lampa.Select && typeof Lampa.Select.opened === 'function' && Lampa.Select.opened());
        } catch (e) {
            return false;
        }
    }

    function restorePlayerController() {
        try {
            if (selectOpened()) {
                if (typeof Lampa.Select.close === 'function') Lampa.Select.close();
                else if (typeof Lampa.Select.hide === 'function') Lampa.Select.hide();
            }
        } catch (e) {}

        try {
            if (!Lampa.Controller || typeof Lampa.Controller.toggle !== 'function') return;
            var name = '';
            try { name = Lampa.Controller.enabled().name; } catch (e2) {}
            if (name === 'select' || name === 'player_panel' || name === 'player_rewind' || !name) {
                Lampa.Controller.toggle('player');
            }
        } catch (e) {}
    }

    function makePanelTrack(meta) {
        var track = {
            index: meta.index,
            language: meta.language || '',
            label: meta.label || '',
            selected: meta.index === state.audioIndex,
            extra: {
                channels: channelsLabel(meta.channels),
                fourCC: meta.codec || ''
            }
        };

        // Без element.onSelect: иначе Select не вернёт Controller и сломается «Назад».
        Object.defineProperty(track, 'enabled', {
            configurable: true,
            enumerable: true,
            get: function () {
                return state.audioIndex === meta.index;
            },
            set: function (value) {
                if (value) switchToAudio(meta.index, meta);
            }
        });

        return track;
    }

    function applyTracksToPanel(force) {
        if (!state.active || !state.tracks.length) return;
        if (state.switching && !force) return;
        if (selectOpened()) return;

        if (Lampa.PlayerPanel && typeof Lampa.PlayerPanel.setTracks === 'function') {
            Lampa.PlayerPanel.setTracks(state.tracks.map(makePanelTrack));
            log('tracks applied', state.tracks.length, 'selected', state.audioIndex);
        }
    }

    function scheduleApplyTracks() {
        clearApplyTimers();
        // Tracks/MediaInfo могут перетереть список чуть позже.
        [0, 500, 2000].forEach(function (ms) {
            state.applyTimers.push(setTimeout(safe(function () {
                if (state.active) applyTracksToPanel(false);
            }), ms));
        });
    }

    function finishSwitch(token) {
        if (token !== state.switchToken) return;
        clearTimer('unlockTimer');
        state.switching = false;
        restorePlayerController();
        scheduleApplyTracks();
    }

    function seekAfterReady(targetTime, token) {
        clearTimer('seekTimer');
        if (!targetTime || targetTime < 3) {
            touchTimeline(null, null, true);
            return;
        }

        var attempts = 0;

        function trySeek() {
            if (token !== state.switchToken || !state.active) return;

            attempts += 1;
            var video = videoEl();
            if (!video || !(video.readyState >= 1 || (video.duration && isFinite(video.duration)))) {
                if (attempts < 40) state.seekTimer = setTimeout(trySeek, 250);
                return;
            }

            var posit = targetTime;
            var duration = video.duration || 0;
            if (duration > 20 && posit > duration - 15) posit = duration - 15;

            try {
                if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.to === 'function') {
                    Lampa.PlayerVideo.to(posit);
                } else {
                    video.currentTime = posit;
                }
                touchTimeline(posit, duration, true);
                log('seek', posit);
            } catch (e) {
                log('seek failed', e && e.message);
            }
        }

        state.seekTimer = setTimeout(trySeek, 400);
    }

    function isUiBusy() {
        if (selectOpened()) return true;

        try {
            var work = playdata();
            if (work && work.timeline && work.timeline.waiting_for_user) return true;
        } catch (e) {}

        try {
            var name = Lampa.Controller && Lampa.Controller.enabled
                ? Lampa.Controller.enabled().name
                : '';
            if (name === 'select') return true;
        } catch (e2) {}

        return false;
    }

    function patchPlaylistAudio(work, audioIndex) {
        if (!work || !work.playlist || !work.playlist.length) return;

        work.playlist.forEach(function (item) {
            if (!item || !isGstUrl(item.url)) return;
            var parsed = parseGstUrl(item.url);
            if (!parsed) return;
            item.url = buildGstUrl(parsed, audioIndex);
        });
    }

    function findTrack(audioIndex) {
        for (var i = 0; i < state.tracks.length; i++) {
            if (state.tracks[i].index === audioIndex) return state.tracks[i];
        }
        return null;
    }

    function switchToAudio(audioIndex, meta) {
        if (!state.active || state.switching) return;

        audioIndex = parseInt(audioIndex, 10);
        if (isNaN(audioIndex) || audioIndex < 0) return;
        if (audioIndex === state.audioIndex) {
            applyTracksToPanel(true);
            return;
        }

        var work = playdata();
        if (!work || !isGstUrl(work.url)) return;

        var parsed = parseGstUrl(work.url);
        if (!parsed) return;

        var pos = currentPosition();
        var nextUrl = buildGstUrl(parsed, audioIndex, pos.time);
        var token = ++state.switchToken;
        var track = meta || findTrack(audioIndex);

        log('switch', state.audioIndex, '->', audioIndex, 'at', pos.time);

        state.switching = true;
        state.audioIndex = audioIndex;
        savePref(track);
        touchTimeline(pos.time, pos.duration, true);

        work.url = nextUrl;
        work.gst_audio = audioIndex;
        patchPlaylistAudio(work, audioIndex);

        notify('Озвучка: ' + ((track && (track.label || track.language)) || ('#' + (audioIndex + 1))));
        restorePlayerController();

        try {
            if (Lampa.PlayerVideo && typeof Lampa.PlayerVideo.destroy === 'function') {
                Lampa.PlayerVideo.destroy(true);
            }
            if (!Lampa.PlayerVideo || typeof Lampa.PlayerVideo.url !== 'function') {
                throw new Error('PlayerVideo.url unavailable');
            }
            Lampa.PlayerVideo.url(toPlayUrl(nextUrl), true);
        } catch (e) {
            state.switching = false;
            restorePlayerController();
            log('switch failed', e && e.message);
            return;
        }

        applyTracksToPanel(true);
        seekAfterReady(pos.time, token);

        clearTimer('unlockTimer');
        state.unlockTimer = setTimeout(safe(function () {
            finishSwitch(token);
        }), 8000);
    }

    function maybeAutoselect(parsed) {
        var track = pickPreferredTrack(state.tracks);
        if (!track) return;

        if (track.index === state.audioIndex || track.index === parsed.audio) {
            state.audioIndex = track.index;
            return;
        }

        clearTimer('autoTimer');

        var attempts = 0;
        function tryAuto() {
            attempts += 1;
            if (!state.active || state.switching) return;

            if (isUiBusy() || attempts < 3) {
                if (attempts < 40) state.autoTimer = setTimeout(tryAuto, attempts < 3 ? 400 : 500);
                return;
            }

            switchToAudio(track.index, track);
        }

        state.autoTimer = setTimeout(tryAuto, 1200);
    }

    function resetState() {
        clearApplyTimers();
        clearTimer('seekTimer');
        clearTimer('autoTimer');
        clearTimer('unlockTimer');
        state.active = false;
        state.switching = false;
        state.audioIndex = 0;
        state.tracks = [];
        state.switchToken += 1;
    }

    function onPlayerStart(data) {
        resetState();

        if (!data || !isGstUrl(data.url)) return;

        var parsed = parseGstUrl(data.url);
        if (!parsed || !parsed.hash || !parsed.fileIndex) return;

        state.active = true;
        state.audioIndex = parsed.audio;
        log('start', parsed.hash, parsed.fileIndex, 'audio', parsed.audio);

        requestProbe(parsed, safe(function (err, json) {
            if (!state.active) return;

            if (err || !json || !json.Tracks) {
                log('probe error', err && err.message);
                return;
            }

            state.tracks = normalizeAudioTracks(json.Tracks);
            if (!state.tracks.length) return;

            applyTracksToPanel(true);
            if (state.tracks.length > 1) {
                scheduleApplyTracks();
                maybeAutoselect(parsed);
            }
        }));
    }

    function onCanPlay() {
        if (!state.active) return;
        if (state.switching) {
            finishSwitch(state.switchToken);
            return;
        }
        scheduleApplyTracks();
    }

    function bind() {
        if (!window.Lampa || !Lampa.Player || !Lampa.Player.listener) {
            setTimeout(bind, 500);
            return;
        }

        Lampa.Player.listener.follow('start', safe(onPlayerStart));
        Lampa.Player.listener.follow('destroy', safe(resetState));

        if (Lampa.PlayerVideo && Lampa.PlayerVideo.listener) {
            Lampa.PlayerVideo.listener.follow('tracks', safe(function () {
                if (state.active && !state.switching) scheduleApplyTracks();
            }));
            Lampa.PlayerVideo.listener.follow('canplay', safe(onCanPlay));
        }

        try {
            console.log(LOG, 'v' + VERSION);
        } catch (e) {}
    }

    if (!window.gst_audio_switch_loaded) {
        window.gst_audio_switch_loaded = true;
        bind();
    }
})();
