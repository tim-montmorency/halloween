/* ───────────────── SyncedAudio Web Component Module ───────────────── */

/**
 * UTC-synchronized audio player with cross-platform compatibility
 * 
 * Features:
 * - UTC time synchronization without server dependency
 * - HLS streaming with MP3 fallback for Android
 * - Automatic latency compensation (AudioContext + user-defined)
 * - Smooth CSS transitions between play/pause states
 * - Media Session API integration for hardware controls
 * - Shadow DOM isolation for style encapsulation
 * 
 * @example
 * <synced-audio
 *   src="audio.m3u8"
 *   srcmp3="audio.mp3" 
 *   title="Track Title"
 *   duration="120"
 *   audio-latency="200"
 *   debug="1">
 * </synced-audio>
 */
export default class SyncedAudio extends HTMLElement {
  IOS_LAG = -1.0;         // fixed seek-lag
  AND_LAG = 0.0;          // reversed lag on android seem's to be required

  static observedAttributes = [
    'title','artist','album','cover',
    'player-play-img','player-pause-img',
    'player-pause-overlay',
    'audio-latency'
  ];

  constructor(){ super(); this.attachShadow({mode:'open'}); }

  connectedCallback(){
    // Config & initialization
    Object.assign(this, {
      debug: this.getAttribute('debug') === '1',
      duration: +this.getAttribute('duration') || 1800,
      baseAllowed: +this.getAttribute('allowed-drift') || 300,
      audioLatency: +this.getAttribute('audio-latency') || 0,
      lat: 0, measuredLatency: 0, audioContext: null,
      isAndroid: /Android/i.test(navigator.userAgent),
      isIOS: /iP(hone|od|ad)/i.test(navigator.userAgent),
      _metaReady: false,
      offset: +this.getAttribute('offset') || 0
    });

    this.debug && console.log('Audio latency:', this.getAttribute('audio-latency'), 'Parsed:', this.audioLatency);

    this.render();

    // DOM refs
    [this.$frame, this.$imgBase, this.$imgOverlay, this.$playAnimOverlay, this.$audio, this.$dbg, this.$playOverlay, this.$pauseOverlay, this.$fullscreenOverlay, this.$progressBar, this.$progressFill, this.$progressIndicator] = 
      ['.frame', '.img-base', '.img-overlay', '.play-animation-overlay', 'audio', '#dbg', '.play-overlay', '.pause-overlay', '.fullscreen-overlay', '.progress-bar', '.progress-fill', '.progress-indicator'].map(s => this.shadowRoot.querySelector(s));

    this.allowed = this.baseAllowed * ((this.isIOS || this.isAndroid) ? 2 : 1);

    // Optional lag overrides
    ['seek-lag-ios', 'seek-lag-android'].forEach((attr, i) => {
      const val = +this.getAttribute(attr);
      if(!isNaN(val)) this[i ? 'AND_LAG' : 'IOS_LAG'] = val;
    });

    // Event handlers
    const toggle = () => this.$audio.paused ? this.$audio.play() : this.$audio.pause();
    
    // Frame click handler - only toggle when paused or when pause button is not visible
    this.$frame?.addEventListener('click', (e) => {
      if(this.$audio.paused || !this.$pauseOverlay?.classList.contains('visible')) {
        toggle();
      }
    });
    
    this.$frame?.addEventListener('keydown', e => {
      if(e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(); }
    });
    
    // Touch/hover interaction for pause button during playback
    ['mouseenter', 'mousemove', 'touchstart', 'touchmove'].forEach(event => {
      this.$frame?.addEventListener(event, () => this.showPauseButton());
    });
    
    // Additional mobile-specific touch interactions
    ['touchend', 'touchcancel'].forEach(event => {
      this.$frame?.addEventListener(event, () => {
        if(!this.$audio.paused) {
          this.showPauseButton(); // Ensure buttons are visible after touch
        }
      });
    });
    
    ['mouseleave'].forEach(event => {
      this.$frame?.addEventListener(event, () => this.hidePauseButtonDelayed());
    });
    
    // Pause button click handler
    this.$pauseOverlay?.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering frame click
      this.$audio.pause();
    });
    
    // Pause button keyboard handler
    this.$pauseOverlay?.addEventListener('keydown', (e) => {
      if(e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.$audio.pause();
      }
    });
    
    // Fullscreen button click handler
    this.$fullscreenOverlay?.addEventListener('click', (e) => {
      e.stopPropagation(); // Prevent triggering frame click
      this.toggleFullscreen();
    });
    
    // Fullscreen button keyboard handler
    this.$fullscreenOverlay?.addEventListener('keydown', (e) => {
      if(e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.toggleFullscreen();
      }
    });
    
    ['play', 'pause', 'ended', 'loadedmetadata'].forEach((event, i) => {
      this.$audio.addEventListener(event, [
        () => this.handlePlay(),
        () => this.handlePause(), 
        () => this.handleEnded(),
        () => this._metaReady = true
      ][i]);
    });

    // Fullscreen change listeners
    ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(event => {
      document.addEventListener(event, () => {
        const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) ||
                            this.$frame?.classList.contains('ios-fullscreen');
        this.updateFullscreenIcon(isFullscreen);
        this.handleFullscreenChange(isFullscreen);
      });
    });

    // Setup
    this.loadSource();
    this.updateMediaSession();
    this.swapImg('play');
    
    const title = this.getAttribute('title') || 'audio cover';
    if(this.$imgBase) { this.$imgBase.alt = title; this.$imgBase.src = this.img('play'); }
    if(this.$imgOverlay) this.$imgOverlay.alt = title;
    
    // Setup play animation overlay
    const overlayImg = this.getAttribute('player-pause-overlay') || 'player-pause_overlay.png';
    if(this.$playAnimOverlay) { 
      this.$playAnimOverlay.alt = 'animated overlay'; 
      this.$playAnimOverlay.src = overlayImg; 
    }
    
    // Ensure play overlay is visible initially (paused state)
    this.$playOverlay?.classList.remove('hidden');
    
    // Initialize cursor auto-hide functionality
    this.initCursorAutoHide();
  }

  attributeChangedCallback(name, oldValue, newValue){ 
    if(name === 'audio-latency') {
      this.audioLatency = +newValue || 0;
      this.debug && console.log('Audio latency updated to:', this.audioLatency);
    }
    this.updateMediaSession(); 
  }

  // Audio context & latency measurement
  async initAudioContext(){
    if(this.audioContext) return;
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await this.measureLatency();
    } catch(e) { console.warn('AudioContext not supported, latency measurement disabled'); }
  }

  async measureLatency(){
    if(!this.audioContext) return;
    try {
      if(this.audioContext.state === 'suspended') await this.audioContext.resume();
      const baseLatency = this.audioContext.baseLatency || 0;
      const outputLatency = this.audioContext.outputLatency || 0;
      this.lat = baseLatency + outputLatency;
      this.measuredLatency = this.lat * 1000;
      this.debug && console.log(`Audio latency: base=${(baseLatency*1000).toFixed(1)}ms, output=${(outputLatency*1000).toFixed(1)}ms, total=${this.measuredLatency.toFixed(1)}ms`);
    } catch(e) { console.warn('Could not measure audio latency:', e); }
  }

  /* ---------- shadow DOM markup & styles ---------- */
  render(){
    this.shadowRoot.innerHTML = `
      <style>
        .frame{
          width:100%;
          border-radius:var(--radius);
          overflow:hidden;
          background:#000;
          cursor:pointer;
          position:relative;
        }
        .frame:fullscreen, .frame.ios-fullscreen{
          display:flex;
          align-items:center;
          justify-content:center;
          height:100vh;
          border-radius:0;
        }
        .frame:fullscreen.hide-cursor, .frame.ios-fullscreen.hide-cursor{
          cursor:none;
        }
        /* iOS fullscreen specific styles */
        .frame.ios-fullscreen{
          position:fixed;
          top:0;
          left:0;
          width:100vw;
          height:100vh;
          z-index:9999;
          background:#000;
        }
        .frame img{
          width:100%;
          height:auto;
          display:block;
          object-fit:contain;
          user-select:none;
          -webkit-user-drag:none;
        }
        .frame:fullscreen img, .frame.ios-fullscreen img{
          position:absolute;
          top:50%;
          left:50%;
          transform:translate(-50%, -50%);
          max-width:100vw;
          max-height:100vh;
          width:auto;
          height:auto;
        }
        .frame .img-overlay{
          position:absolute;
          top:0;
          left:0;
          width:100%;
          height:100%;
          opacity:0;
          transition: opacity 0.3s ease-in-out;
          pointer-events:none;
        }
        .frame .img-overlay.active{
          opacity:1;
        }
        .play-animation-overlay{
          position:absolute;
          top:0;
          left:0;
          width:100%;
          height:100%;
          opacity:0;
          transition:opacity 0.5s ease-in-out;
          pointer-events:none;
          mix-blend-mode:overlay;
        }
        .play-animation-overlay.active{
          opacity:0.6;
        }
        .play-overlay{
          position:absolute;
          top:50%;
          left:50%;
          transform:translate(-50%, -50%);
          width:90px;
          height:90px;
          display:flex;
          align-items:center;
          justify-content:center;
          opacity:1;
          transition:opacity 0.3s ease-in-out;
          pointer-events:none;
          mix-blend-mode:screen;
        }
        .play-overlay.hidden{
          opacity:0;
        }
        .pause-overlay{
          position:absolute;
          top:50%;
          left:50%;
          transform:translate(-50%, -50%);
          width:90px;
          height:90px;
          display:flex;
          align-items:center;
          justify-content:center;
          opacity:0;
          transition:opacity 0.3s ease-in-out;
          pointer-events:none;
          mix-blend-mode:screen;
          cursor:pointer;
        }
        .pause-overlay.visible{
          opacity:1;
          pointer-events:auto;
        }
        .pause-overlay svg{
          width:90px;
          height:90px;
          filter:drop-shadow(0 0 12px rgba(255,255,255,0.6)) drop-shadow(0 0 24px rgba(255,255,255,0.3));
        }
        .fullscreen-overlay{
          position:absolute;
          bottom:calc(2% + 2px);
          right:10%;
          width:60px;
          height:60px;
          display:flex;
          align-items:center;
          justify-content:center;
          opacity:0;
          transition:opacity 0.3s ease-in-out;
          pointer-events:none;
          cursor:pointer;
          /* Larger touch target */
          padding:20px;
          box-sizing:border-box;
          /* Center with progress bar */
          transform:translateY(50%);
        }
        .fullscreen-overlay.visible{
          opacity:1;
          pointer-events:auto;
        }
        .fullscreen-overlay.visible.dimmed{
          opacity:0.3;
        }
        .fullscreen-overlay svg{
          width:20px;
          height:20px;
          filter:drop-shadow(0 0 4px rgba(255,255,255,0.3));
        }
        @media(max-width:640px){
          .pause-overlay{
            width:70px;
            height:70px;
          }
          .pause-overlay svg{
            width:70px;
            height:70px;
          }
          .fullscreen-overlay{
            bottom:calc(10% + 1.5px);
            right:8%;
            width:68px;
            height:68px;
            padding:24px;
            transform:translateY(50%);
          }
          .fullscreen-overlay svg{
            width:20px;
            height:20px;
          }
          /* Mobile fullscreen adjustments */
          .frame:fullscreen .pause-overlay, .frame.ios-fullscreen .pause-overlay{
            position:fixed !important;
            top:50% !important;
            left:50% !important;
            transform:translate(-50%, -50%) !important;
            width:80px;
            height:80px;
            z-index:10000;
            transition:opacity 0.3s ease-in-out !important;
          }
          .frame:fullscreen .pause-overlay svg, .frame.ios-fullscreen .pause-overlay svg{
            width:80px;
            height:80px;
          }
          .frame:fullscreen .fullscreen-overlay{
            bottom:2%;
            left:90%;
            width:72px;
            height:72px;
            padding:26px;
            transform:translate(-50%, -50%);
          }
          .frame:fullscreen .fullscreen-overlay svg{
            width:20px;
            height:20px;
          }
          .frame:fullscreen .play-overlay{
            width:80px;
            height:80px;
          }
          .frame:fullscreen .play-overlay svg{
            width:80px;
            height:80px;
          }
        }
        .play-overlay svg{
          width:90px;
          height:90px;
          filter:drop-shadow(0 0 16px rgba(255,255,255,0.8)) drop-shadow(0 0 32px rgba(255,255,255,0.5)) drop-shadow(0 0 48px rgba(255,255,255,0.3));
        }
        @media(max-width:640px){
          .play-overlay{
            width:70px;
            height:70px;
          }
          .play-overlay svg{
            width:70px;
            height:70px;
          }
        }
        .progress-bar{
          position:absolute;
          bottom:2%;
          left:10%;
          right:10%;
          height:4px;
          background:rgba(255,255,255,0.2);
          border-radius:2px;
          overflow:hidden;
          opacity:0;
          transition:opacity 0.3s ease-in-out;
          backdrop-filter:blur(2px);
          -webkit-backdrop-filter:blur(2px);
        }
        .progress-bar.visible{
          opacity:1;
        }
        .progress-fill{
          height:100%;
          width:0%;
          background:linear-gradient(90deg, 
            rgba(255,255,255,0.3) 0%, 
            rgba(255,255,255,0.5) 50%, 
            rgba(255,255,255,0.3) 100%);
          border-radius:2px;
          transition:width 0.1s ease-out;
          position:relative;
        }
        .progress-indicator{
          position:absolute;
          top:50%;
          right:0;
          transform:translate(50%, -50%);
          width:10px;
          height:10px;
          background:rgba(255,255,255,0.9);
          border:1px solid rgba(255,255,255,0.6);
          border-radius:50%;
          box-shadow:0 0 8px rgba(255,255,255,0.4);
          transition:all 0.1s ease-out;
        }
        @media(max-width:640px){
          .progress-bar{
            height:3px;
            bottom:10%;
            left:8%;
            right:8%;
          }
          .progress-indicator{
            width:8px;
            height:8px;
          }
        }
        audio{width:100%;margin-top:.5rem}
        .debug{
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
          font-size: 12px;
          border: 2px solid #333;
          border-radius: 8px;
          overflow: hidden;
          margin-top: 1rem;
          background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
          box-shadow: 0 4px 12px rgba(0,0,0,0.4);
        }
        .debug table{
          width: 100%;
          border-collapse: collapse;
          margin: 0;
        }
        .debug td{
          padding: 8px 12px;
          border-bottom: 1px solid #444;
          vertical-align: top;
        }
        .debug tr:last-child td{
          border-bottom: none;
        }
        .debug tr:nth-child(odd){
          background: rgba(255,255,255,0.03);
        }
        .debug tr:hover{
          background: rgba(64,156,255,0.1);
        }
        .debug .k{
          color: #60a5fa;
          text-align: right;
          font-weight: 600;
          min-width: 140px;
          border-right: 1px solid #444;
        }
        .debug .v{
          color: #e5e7eb;
          font-weight: 500;
          font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
        }
        @media(max-width:640px){ 
          .debug{font-size:11px}
          .debug .k{min-width:120px}
          .debug td{padding:6px 8px}
        }
        .sr-only{
          position:absolute;
          width:1px;
          height:1px;
          padding:0;
          margin:-1px;
          overflow:hidden;
          clip:rect(0,0,0,0);
          white-space:nowrap;
          border:0;
        }
      </style>

      <div class="frame" role="button" tabindex="0" aria-pressed="false" aria-label="Play/pause audio">
        <img alt="cover" class="img-base" />
        <img alt="cover" class="img-overlay" />
        <img alt="cover overlay" class="play-animation-overlay" />
        <div class="play-overlay">
          <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <radialGradient id="circleGradient" cx="50%" cy="50%" r="50%">
                <stop offset="70%" style="stop-color:rgba(255,255,255,0.4);stop-opacity:1" />
                <stop offset="100%" style="stop-color:rgba(255,255,255,0.8);stop-opacity:1" />
              </radialGradient>
            </defs>
            <circle cx="40" cy="40" r="35" 
                    fill="none" 
                    stroke="url(#circleGradient)" 
                    stroke-width="3" 
                    opacity="1"/>
            <path d="M32 28 L32 52 L52 40 Z" 
                  fill="rgba(255,255,255,0.8)" 
                  stroke="rgba(255,255,255,1)" 
                  stroke-width="1.5"/>
          </svg>
        </div>
        <div class="pause-overlay" 
             role="button" 
             tabindex="0" 
             aria-label="Pause audio" 
             aria-describedby="pause-description">
          <svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              <radialGradient id="pauseCircleGradient" cx="50%" cy="50%" r="50%">
                <stop offset="70%" style="stop-color:rgba(255,255,255,0.2);stop-opacity:1" />
                <stop offset="100%" style="stop-color:rgba(255,255,255,0.6);stop-opacity:1" />
              </radialGradient>
            </defs>
            <circle cx="40" cy="40" r="35" 
                    fill="none" 
                    stroke="url(#pauseCircleGradient)" 
                    stroke-width="3" 
                    opacity="0.9"/>
            <rect x="30" y="28" width="6" height="24" 
                  fill="rgba(255,255,255,0.5)" 
                  stroke="rgba(255,255,255,0.8)" 
                  stroke-width="1"/>
            <rect x="44" y="28" width="6" height="24" 
                  fill="rgba(255,255,255,0.5)" 
                  stroke="rgba(255,255,255,0.8)" 
                  stroke-width="1"/>
          </svg>
          <span id="pause-description" class="sr-only">Pause the currently playing audio</span>
        </div>
        <div class="fullscreen-overlay" 
             role="button" 
             tabindex="0" 
             aria-label="Toggle fullscreen" 
             aria-describedby="fullscreen-description">
          <svg viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <!-- Fullscreen expand icon - more subtle design -->
            <path d="M6 6 L6 9 L9 9 M14 6 L14 9 L11 9 M6 14 L6 11 L9 11 M14 14 L14 11 L11 11" 
                  fill="none" 
                  stroke="rgba(255,255,255,0.6)" 
                  stroke-width="1.5" 
                  stroke-linecap="round"/>
          </svg>
          <span id="fullscreen-description" class="sr-only">Enter or exit fullscreen mode</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill">
            <div class="progress-indicator"></div>
          </div>
        </div>
      </div>
      <audio ${this.debug?'controls':''} crossorigin="anonymous" preload="metadata" loop></audio>
      ${this.debug ? "<div class='debug'><table id='dbg'></table></div>" : ""}
    `;
  }

  // Helper methods
  img(state){ return this.getAttribute(`player-${state}-img`) || this.getAttribute('cover'); }
  
  swapImg(state){ 
    const newSrc = this.img(state);
    this.$imgOverlay.src = newSrc;
    this.$imgOverlay.classList.add('active');
    setTimeout(() => {
      this.$imgBase.src = newSrc;
      this.$imgOverlay.classList.remove('active');
    }, 300);
  }

  // Time calculations
  utc(){ return ((Date.now()/1000 + this.offset) % this.duration + this.duration) % this.duration; }
  targetTime(){ 
    const totalLatency = this.lat + this.lag() + this.audioLatency/1000;
    return ((Date.now()/1000 + this.offset + totalLatency) % this.duration + this.duration) % this.duration;
  }
  lag(){ return this.isIOS ? this.IOS_LAG : this.isAndroid ? this.AND_LAG : 0; }

  // Media Session API integration
  updateMediaSession(){
    if(!navigator.mediaSession) return;
    
    navigator.mediaSession.metadata = new MediaMetadata({
      title: this.getAttribute('title') || '',
      artist: this.getAttribute('artist') || '',
      album: this.getAttribute('album') || '',
      artwork: [{src: this.getAttribute('cover')||'', sizes:'512x512', type:'image/png'}]
    });
    
    if(navigator.mediaSession.setActionHandler) {
      const handlers = {
        play: async () => await this.$audio.play(),
        pause: () => this.$audio.pause(),
        seekbackward: (details) => this.seek(-(details.seekOffset || 10)),
        seekforward: (details) => this.seek(details.seekOffset || 10)
      };
      
      try {
        Object.entries(handlers).forEach(([action, handler]) => 
          navigator.mediaSession.setActionHandler(action, handler));
      } catch(e) { this.debug && console.warn('Media Session API not fully supported:', e); }
    }
    
    navigator.mediaSession.playbackState = this.$audio?.paused ? 'paused' : 'playing';
  }

  seek(offset) {
    const duration = this.$audio.duration || 0;
    this.$audio.currentTime = Math.max(0, Math.min(duration, this.$audio.currentTime + offset));
    if(!this.$audio.paused) this.sync(true);
  }

  // Audio source loading with HLS.js dynamic import
  async loadSource(){
    const [hls, mp3] = [this.getAttribute('src'), this.getAttribute('srcmp3')];
    
    if(this.debug) console.log('🔄 loadSource called with:', { hls, mp3, isAndroid: this.isAndroid });
    
    // For Android, set up a quick MP3 fallback timer in case HLS fails silently
    let androidFallbackTimer;
    if(this.isAndroid && mp3) {
      androidFallbackTimer = setTimeout(() => {
        if(!this.$audio.duration || this.$audio.duration === 0) {
          console.warn('⏰ Android fallback timer triggered, switching to MP3');
          this.fallbackToMP3(mp3);
        }
      }, 3000); // 3 second fallback for Android
    }
    
    // Try HLS first on all platforms (including Android)
    const nativeHLS = this.$audio.canPlayType('application/vnd.apple.mpegurl') || 
                      this.$audio.canPlayType('application/x-mpegURL');

    if(hls?.endsWith('.m3u8')) {
      if(nativeHLS) {
        if(this.debug) console.log('🎵 Using native HLS support');
        this.$audio.src = hls;
        // Add load event listener to verify it works
        this.$audio.addEventListener('loadedmetadata', () => {
          if(this.debug) console.log('✅ Native HLS loaded successfully');
          if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
        }, { once: true });
        this.$audio.addEventListener('error', (e) => {
          console.warn('❌ Native HLS failed, falling back to MP3:', e);
          if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
          this.fallbackToMP3(mp3);
        }, { once: true });
      } else {
        if(this.debug) console.log('🎵 Loading HLS.js for HLS support');
        try {
          const hlsSupported = await this.loadHlsJs();
          if(hlsSupported && window.Hls && Hls.isSupported()) {
            this.hlsInstance = new Hls({
              enableWorker: true,
              startLevel: -1, // Auto quality selection
              capLevelToPlayerSize: true
            });
            
            // Add success handler
            this.hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
              if(this.debug) console.log('✅ HLS.js manifest parsed successfully');
              if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
            });
            
            // Add error handling for HLS.js
            this.hlsInstance.on(Hls.Events.ERROR, (event, data) => {
              if(data.fatal) {
                console.warn('🚨 HLS.js fatal error, falling back to MP3:', data);
                if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
                this.fallbackToMP3(mp3);
              } else {
                console.warn('⚠️ HLS.js non-fatal error:', data);
              }
            });
            
            this.hlsInstance.loadSource(hls);
            this.hlsInstance.attachMedia(this.$audio);
            
            if(this.debug) console.log('✅ HLS.js initialized successfully');
            
          } else {
            console.warn('🚫 HLS.js not supported, falling back to MP3');
            if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
            this.fallbackToMP3(mp3);
          }
        } catch(e) { 
          console.warn('❌ HLS.js loading failed, falling back to MP3:', e); 
          if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
          this.fallbackToMP3(mp3);
        }
      }
    } else if(mp3) {
      if(this.debug) console.log('🎵 No HLS source, using MP3 directly');
      if(androidFallbackTimer) clearTimeout(androidFallbackTimer);
      this.fallbackToMP3(mp3);
    } else {
      console.error('❌ No audio sources available');
    }
  }

  // Fallback to MP3 with preloading
  fallbackToMP3(mp3) {
    if(mp3) {
      if(this.debug) console.log('🔄 Switching to MP3:', mp3);
      
      // Clean up HLS instance if it exists
      if(this.hlsInstance) {
        try {
          this.hlsInstance.destroy();
          this.hlsInstance = null;
          if(this.debug) console.log('🧹 HLS.js instance destroyed');
        } catch(e) {
          console.warn('⚠️ Error destroying HLS.js instance:', e);
        }
      }
      
      // Set MP3 source
      this.$audio.src = mp3;
      this.$audio.load(); // Force reload
      
      // Add event listeners to verify MP3 loading
      this.$audio.addEventListener('loadedmetadata', () => {
        if(this.debug) console.log('✅ MP3 metadata loaded, duration:', this.$audio.duration);
      }, { once: true });
      
      this.$audio.addEventListener('canplay', () => {
        if(this.debug) console.log('✅ MP3 ready to play');
      }, { once: true });
      
      this.$audio.addEventListener('error', (e) => {
        console.error('❌ MP3 also failed to load:', e);
      }, { once: true });
      
      // Start preloading
      this.preloadMP3(mp3);
    } else {
      console.error('❌ No MP3 fallback available');
    }
  }

  async loadHlsJs(){
    if(window.Hls || this._hlsLoading) return this._hlsLoading;
    
    this._hlsLoading = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/hls.js@1';
      script.onload = () => { 
        if(this.debug) console.log('📦 HLS.js loaded dynamically');
        if(window.Hls && Hls.isSupported()) {
          if(this.debug) console.log('✅ HLS.js is supported on this platform');
          resolve();
        } else {
          if(this.debug) console.log('❌ HLS.js loaded but not supported on this platform');
          reject(new Error('HLS.js not supported'));
        }
      };
      script.onerror = () => { 
        console.warn('❌ Failed to load HLS.js from CDN'); 
        reject(new Error('Failed to load HLS.js'));
      };
      document.head.appendChild(script);
    });
    
    try { 
      await this._hlsLoading; 
      return true;
    } catch(e) { 
      if(this.debug) console.log('🚫 HLS.js loading failed:', e.message);
      return false;
    } finally { 
      this._hlsLoading = null; 
    }
  }

  // Preload MP3 file to ensure it's downloaded and buffered
  preloadMP3(mp3Url) {
    if(this.debug) console.log('🎵 Preloading MP3:', mp3Url);
    
    // Create a hidden audio element to force download
    if(!this._preloadAudio) {
      this._preloadAudio = document.createElement('audio');
      this._preloadAudio.preload = 'auto';
      this._preloadAudio.style.display = 'none';
      this._preloadAudio.crossOrigin = 'anonymous';
      this._preloadAudio.loop = true; // Match main audio loop setting
      
      // Add event listeners to track preload progress
      this._preloadAudio.addEventListener('loadstart', () => {
        if(this.debug) console.log('🔄 MP3 preload started');
      });
      
      this._preloadAudio.addEventListener('canplaythrough', () => {
        if(this.debug) console.log('✅ MP3 fully preloaded and ready');
        // Force the main audio element to also benefit from preloading
        this.$audio.preload = 'auto';
        this.$audio.load();
      });
      
      this._preloadAudio.addEventListener('loadedmetadata', () => {
        if(this.debug) console.log('📋 MP3 preload metadata loaded, duration:', this._preloadAudio.duration);
      });
      
      this._preloadAudio.addEventListener('progress', () => {
        if(this._preloadAudio.buffered.length > 0) {
          const buffered = this._preloadAudio.buffered.end(0);
          const duration = this._preloadAudio.duration || 1;
          const percent = (buffered / duration * 100).toFixed(1);
          if(this.debug) console.log(`📥 MP3 preload progress: ${percent}% (${buffered.toFixed(1)}s/${duration.toFixed(1)}s)`);
        }
      });
      
      this._preloadAudio.addEventListener('error', (e) => {
        console.warn('❌ MP3 preload failed:', e);
      });
    }
    
    // Start preloading
    this._preloadAudio.src = mp3Url;
    this._preloadAudio.load();
    
    // Also ensure main audio element has optimal preload settings
    this.$audio.preload = 'auto';
    
    // For hosted environments, add a prefetch link to help with caching
    if(!document.querySelector(`link[href="${mp3Url}"]`)) {
      const prefetchLink = document.createElement('link');
      prefetchLink.rel = 'prefetch';
      prefetchLink.href = mp3Url;
      prefetchLink.as = 'audio';
      prefetchLink.crossOrigin = 'anonymous';
      document.head.appendChild(prefetchLink);
      if(this.debug) console.log('🔗 Added prefetch link for MP3');
    }
  }

  // Playback control handlers
  async handlePlay(){
    this.swapImg('pause');
    this.$frame?.setAttribute('aria-pressed','true');
    this.$playOverlay?.classList.add('hidden');
    this.$playAnimOverlay?.classList.add('active');
    this.$progressBar?.classList.add('visible');
    this.$fullscreenOverlay?.classList.add('visible');
    if(navigator.mediaSession) navigator.mediaSession.playbackState = 'playing';
    
    if(!this._metaReady) {
      const once = () => { this.$audio.removeEventListener('loadedmetadata', once); this.handlePlay(); };
      this.$audio.addEventListener('loadedmetadata', once);
      return;
    }
    
    await this.initAudioContext();
    this.sync(true);
    this.startSync();
    this.startProgressUpdates();
    this.startAnimationUpdates();
    if(this.debug) this._dbg = setInterval(() => this.paint(), 250);
    
    // Sync state with fullscreen clone if it exists
    this.syncFullscreenState();
  }
  
  handlePause(){
    this.swapImg('play');
    this.$frame?.setAttribute('aria-pressed','false');
    this.$playOverlay?.classList.remove('hidden');
    this.$playAnimOverlay?.classList.remove('active');
    this.$progressBar?.classList.remove('visible');
    
    // Keep fullscreen button visible if in fullscreen mode
    const isInFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) ||
                          this.$frame?.classList.contains('ios-fullscreen');
    if(!isInFullscreen) {
      this.$fullscreenOverlay?.classList.remove('visible');
    } else {
      // Ensure fullscreen button is bright when paused in fullscreen
      this.brightenFullscreenButton();
    }
    
    // Sync state with fullscreen clone if it exists
    this.syncFullscreenState();
    
    this.hidePauseButtonImmediately();
    if(navigator.mediaSession) navigator.mediaSession.playbackState = 'paused';
    this.stopSync();
    this.stopProgressUpdates();
    this.stopAnimationUpdates();
    clearInterval(this._dbg);
  }
  
  handleEnded(){ 
    this.$audio.currentTime = this.targetTime(); 
    this.hidePauseButtonImmediately();
    
    // Exit fullscreen when audio ends
    this.exitFullscreen();
  }

  // Synchronization logic
  sync(force=false){
    const [currentTime, targetTime] = [this.$audio.currentTime, this.targetTime()];
    const drift = (currentTime - targetTime) * 1000;
    
    // Detect stuck playback (currentTime not progressing) - mainly for MP3
    if(!this.$audio.paused && !this._lastCurrentTime) this._lastCurrentTime = currentTime;
    const isMP3Mode = this.$audio.src.includes('.mp3');
    if(isMP3Mode && !this.$audio.paused && this._lastCurrentTime === currentTime && currentTime < 2) {
      // Audio is playing but stuck at beginning - likely buffering issue
      if(!this._stuckCount) this._stuckCount = 0;
      this._stuckCount++;
      
      if(this.debug) console.log(`🚫 Audio stuck at ${currentTime.toFixed(3)}s (count: ${this._stuckCount})`);
      
      // Try recovery after being stuck for a while
      if(this._stuckCount > 10) { // About 1 second of being stuck
        this.recoverFromStuck(targetTime);
        this._stuckCount = 0;
      }
      return;
    } else {
      // Reset stuck detection when audio progresses
      this._lastCurrentTime = currentTime;
      this._stuckCount = 0;
    }
    
    // Seamless loop detection
    if(this.$audio.duration && !this._looping) {
      const timeToEnd = this.$audio.duration - currentTime;
      if(timeToEnd <= 0.1 && timeToEnd > 0) {
        this._looping = true;
        this.$audio.currentTime = targetTime;
        setTimeout(() => this._looping = false, 200);
        return;
      }
    }
    
    // Drift correction with mobile debouncing
    if(force || Math.abs(drift) > this.allowed) {
      const now = Date.now();
      const isMP3Mode = this.$audio.src.includes('.mp3');
      
      if(!this._lastSeek || (now - this._lastSeek) > 500) {
        
        if(isMP3Mode) {
          // MP3-specific buffering stimulation
          const safePosition = this.findSafeSeekPosition(targetTime);
          const currentBufferedEnd = this.getCurrentBufferedEnd();
          
          if(safePosition > currentTime) {
            this.$audio.currentTime = safePosition;
            this.ensureMP3Playback();
            if(this.debug) console.log(`🏃 MP3 safe advance: ${currentTime.toFixed(3)}s → ${safePosition.toFixed(3)}s (target: ${targetTime.toFixed(3)}s)`);
          } else if(currentBufferedEnd > currentTime + 0.5) {
            const jumpTarget = Math.min(currentBufferedEnd - 0.2, targetTime);
            this.$audio.currentTime = jumpTarget;
            this.ensureMP3Playback();
            if(this.debug) console.log(`⚡ MP3 buffer-edge jump: ${currentTime.toFixed(3)}s → ${jumpTarget.toFixed(3)}s`);
          } else {
            const forceJump = Math.min(currentTime + 2, targetTime);
            if(forceJump > currentTime) {
              this.$audio.currentTime = forceJump;
              this.ensureMP3Playback();
              if(this.debug) console.log(`💪 MP3 force jump: ${currentTime.toFixed(3)}s → ${forceJump.toFixed(3)}s`);
            }
          }
        } else {
          // HLS and other formats: simple direct seeking
          this.$audio.currentTime = targetTime;
          if(this.debug && Math.abs(drift) > this.allowed * 2) {
            console.log(`� Direct sync: drift ${drift.toFixed(1)}ms, seeking to ${targetTime.toFixed(3)}s`);
          }
        }
        
        this._lastSeek = now;
      }
    }
  }

  // Recovery mechanism for stuck playback
  recoverFromStuck(targetTime) {
    if(this.debug) console.log('🔧 Attempting stuck audio recovery');
    
    // Try multiple recovery strategies
    try {
      // Strategy 1: Force reload and play
      this.$audio.load();
      this.$audio.play().then(() => {
        if(this.debug) console.log('✅ Recovery: reload successful');
        // After reload, try to seek to a safe position
        setTimeout(() => {
          const safePosition = this.findSafeSeekPosition(targetTime);
          if(safePosition > 0) {
            this.$audio.currentTime = safePosition;
          }
        }, 100);
      }).catch(e => {
        if(this.debug) console.log('❌ Recovery: reload failed', e);
      });
      
    } catch(e) {
      if(this.debug) console.log('❌ Recovery failed:', e);
    }
  }

  // Check if a position is buffered
  isPositionBuffered(position) {
    if(!this.$audio.buffered || this.$audio.buffered.length === 0) return false;
    
    for(let i = 0; i < this.$audio.buffered.length; i++) {
      const start = this.$audio.buffered.start(i);
      const end = this.$audio.buffered.end(i);
      if(position >= start && position <= end) {
        return true;
      }
    }
    return false;
  }

  // Find the closest buffered position to target
  findSafeSeekPosition(targetTime) {
    if(!this.$audio.buffered || this.$audio.buffered.length === 0) {
      return this.$audio.currentTime;
    }
    
    let safestPosition = this.$audio.currentTime;
    
    // Find the buffered range that gets us closest to target
    for(let i = 0; i < this.$audio.buffered.length; i++) {
      const start = this.$audio.buffered.start(i);
      const end = this.$audio.buffered.end(i);
      
      // If this range contains our target, we can seek directly
      if(targetTime >= start && targetTime <= end) {
        return targetTime;
      }
      
      // If this range gets us closer to target than current position
      if(start > safestPosition && start <= targetTime) {
        safestPosition = Math.min(end - 0.5, targetTime); // Leave small buffer
      }
    }
    
    return safestPosition;
  }

  // Ensure MP3 playback continues after seeking
  ensureMP3Playback() {
    // Only handle MP3 sources and only if we know playback was active
    if(!this.$audio.src.includes('.mp3')) return;
    
    // Simple check: if audio got paused immediately after a seek in MP3 mode
    // This is a common issue with MP3 seeking on some browsers
    setTimeout(() => {
      if(this.$audio.paused && this.$audio.src.includes('.mp3')) {
        // Only try to resume if the pause seems to be seek-related
        // (very short pause time indicates it wasn't user-initiated)
        this.$audio.play().catch(e => {
          // Silently handle - this is just an optimization attempt
          if(this.debug) console.log('⚠️ MP3 auto-resume failed (expected in some cases):', e);
        });
      }
    }, 100); // Increased timeout to be less aggressive
  }

  // Get the furthest buffered position from current time
  getCurrentBufferedEnd() {
    if(!this.$audio.buffered || this.$audio.buffered.length === 0) {
      return this.$audio.currentTime;
    }
    
    const currentTime = this.$audio.currentTime;
    let furthestEnd = currentTime;
    
    // Find the buffered range that contains current time and get its end
    for(let i = 0; i < this.$audio.buffered.length; i++) {
      const start = this.$audio.buffered.start(i);
      const end = this.$audio.buffered.end(i);
      
      // If current time is in this range, this is our active buffer
      if(currentTime >= start && currentTime <= end) {
        furthestEnd = end;
        break;
      }
      
      // Also consider ranges that start after current time
      if(start > currentTime) {
        furthestEnd = Math.max(furthestEnd, end);
      }
    }
    
    return furthestEnd;
  }

  // Get all buffered ranges for debugging
  getBufferedRanges() {
    if(!this.$audio.buffered || this.$audio.buffered.length === 0) {
      return [];
    }
    
    const ranges = [];
    for(let i = 0; i < this.$audio.buffered.length; i++) {
      ranges.push({
        start: this.$audio.buffered.start(i).toFixed(3),
        end: this.$audio.buffered.end(i).toFixed(3),
        duration: (this.$audio.buffered.end(i) - this.$audio.buffered.start(i)).toFixed(3)
      });
    }
    return ranges;
  }

  startSync(){
    this.stopSync();
    this._syncInterval = setInterval(() => this.sync(), (this.isIOS || this.isAndroid) ? 100 : 16);
  }
  
  stopSync(){ if(this._syncInterval) { clearInterval(this._syncInterval); this._syncInterval = null; } }

  // Progress bar updates (using requestAnimationFrame for optimal performance)
  startProgressUpdates(){
    this.stopProgressUpdates();
    this._progressAnimationActive = true;
    this.animateProgress();
  }
  
  stopProgressUpdates(){ 
    this._progressAnimationActive = false;
    if(this._progressAnimationId) {
      cancelAnimationFrame(this._progressAnimationId);
      this._progressAnimationId = null;
    }
  }

  animateProgress(){
    if(!this._progressAnimationActive) return;
    
    // Throttle to ~10fps instead of 60fps for better performance
    const now = performance.now();
    if(!this._lastProgressUpdate || now - this._lastProgressUpdate >= 100) {
      this.updateProgress();
      this._lastProgressUpdate = now;
    }
    
    this._progressAnimationId = requestAnimationFrame(() => this.animateProgress());
  }

  // Progress bar update
  updateProgress(){
    if(!this.$progressFill || !this.$audio.duration) return;
    
    const currentTime = this.$audio.currentTime;
    const duration = this.$audio.duration;
    const progressPercent = Math.min(100, Math.max(0, (currentTime / duration) * 100));
    
    // Update original progress bar
    this.$progressFill.style.width = `${progressPercent}%`;
    
    // Update fullscreen clone progress bar if it exists
    if(this.fullscreenOverlay) {
      const clonedProgressFill = this.fullscreenOverlay.querySelector('.progress-fill');
      if(clonedProgressFill) {
        // Force the update with transition
        clonedProgressFill.style.setProperty('width', `${progressPercent}%`, 'important');
        clonedProgressFill.style.setProperty('transition', 'width 0.1s ease-out', 'important');
      }
    }
  }

  // Pause button interaction handlers
  showPauseButton(){
    if(!this.$audio.paused) {
      // Force immediate positioning for fullscreen mode
      const isInFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) ||
                            this.$frame?.classList.contains('ios-fullscreen');
      
      if(isInFullscreen && this.$pauseOverlay) {
        // Force immediate fullscreen positioning to prevent flash
        this.$pauseOverlay.style.position = 'fixed';
        this.$pauseOverlay.style.top = '50%';
        this.$pauseOverlay.style.left = '50%';
        this.$pauseOverlay.style.transform = 'translate(-50%, -50%)';
        this.$pauseOverlay.style.zIndex = '10000';
      }
      
      this.$pauseOverlay?.classList.add('visible');
      this.showCursor(); // Show cursor when buttons are shown
      this.hidePauseButtonDelayed();
    } else {
      // Ensure pause button is hidden when audio is paused
      this.hidePauseButtonImmediately();
    }
  }

  hidePauseButtonDelayed(){
    clearTimeout(this._pauseButtonTimeout);
    this._pauseButtonTimeout = setTimeout(() => {
      this.$pauseOverlay?.classList.remove('visible');
    }, 1000); // Hide after 1 second of inactivity
  }

  hidePauseButtonImmediately(){
    clearTimeout(this._pauseButtonTimeout);
    this.$pauseOverlay?.classList.remove('visible');
  }

  // Fullscreen cursor management
  handleFullscreenChange(isFullscreen){
    if(isFullscreen) {
      this.startCursorHiding();
      this.startFullscreenButtonDimming();
    } else {
      this.stopCursorHiding();
      this.stopFullscreenButtonDimming();
      this.showCursor();
      this.brightenFullscreenButton();
      this.resetPauseButtonStyles();
    }
  }

  resetPauseButtonStyles(){
    if(this.$pauseOverlay) {
      // Reset inline styles when exiting fullscreen
      this.$pauseOverlay.style.position = '';
      this.$pauseOverlay.style.top = '';
      this.$pauseOverlay.style.left = '';
      this.$pauseOverlay.style.transform = '';
      this.$pauseOverlay.style.zIndex = '';
    }
  }

  startCursorHiding(){
    if(this.isIOS || this.isAndroid) return; // Skip cursor hiding on mobile
    
    this.stopCursorHiding();
    this.showCursor();
    
    // Add mouse movement listener
    this._mouseMoveHandler = () => {
      this.showCursor();
      this.brightenFullscreenButton(); // Also brighten fullscreen button on mouse move
      this.resetCursorHideTimeout();
    };
    
    this.$frame?.addEventListener('mousemove', this._mouseMoveHandler);
    this.resetCursorHideTimeout();
  }

  stopCursorHiding(){
    if(this._mouseMoveHandler) {
      this.$frame?.removeEventListener('mousemove', this._mouseMoveHandler);
      this._mouseMoveHandler = null;
    }
    clearTimeout(this._cursorHideTimeout);
  }

  resetCursorHideTimeout(){
    clearTimeout(this._cursorHideTimeout);
    this._cursorHideTimeout = setTimeout(() => {
      this.hideCursor();
      this.dimFullscreenButton(); // Also dim fullscreen button when hiding cursor
    }, 3000); // Hide cursor and dim button after 3 seconds of inactivity
  }

  showCursor(){
    this.$frame?.classList.remove('hide-cursor');
  }

  hideCursor(){
    this.$frame?.classList.add('hide-cursor');
  }

  // Fullscreen button dimming management
  startFullscreenButtonDimming(){
    this.stopFullscreenButtonDimming();
    this.brightenFullscreenButton();
    
    // Add interaction listeners for fullscreen button area
    this._fullscreenInteractionHandler = () => {
      this.brightenFullscreenButton();
      this.resetFullscreenDimTimeout();
    };
    
    // Listen for interactions near the fullscreen button
    ['mousemove', 'touchstart', 'touchmove'].forEach(event => {
      this.$fullscreenOverlay?.addEventListener(event, this._fullscreenInteractionHandler);
    });
    
    this.resetFullscreenDimTimeout();
  }

  stopFullscreenButtonDimming(){
    if(this._fullscreenInteractionHandler) {
      ['mousemove', 'touchstart', 'touchmove'].forEach(event => {
        this.$fullscreenOverlay?.removeEventListener(event, this._fullscreenInteractionHandler);
      });
      this._fullscreenInteractionHandler = null;
    }
    clearTimeout(this._fullscreenDimTimeout);
  }

  resetFullscreenDimTimeout(){
    clearTimeout(this._fullscreenDimTimeout);
    
    // Don't dim fullscreen button when audio is paused - user likely to interact
    if(this.$audio?.paused) {
      return;
    }
    
    this._fullscreenDimTimeout = setTimeout(() => {
      this.dimFullscreenButton();
    }, 3000); // Dim fullscreen button after 3 seconds of inactivity
  }

  brightenFullscreenButton(){
    this.$fullscreenOverlay?.classList.remove('dimmed');
  }

  dimFullscreenButton(){
    this.$fullscreenOverlay?.classList.add('dimmed');
  }

  // UTC-synchronized animation updates
  startAnimationUpdates(){
    this.stopAnimationUpdates();
    this._animationUpdateActive = true;
    this.animateHue();
  }
  
  stopAnimationUpdates(){ 
    this._animationUpdateActive = false;
    if(this._animationUpdateId) {
      cancelAnimationFrame(this._animationUpdateId);
      this._animationUpdateId = null;
    }
  }

  animateHue(){
    if(!this._animationUpdateActive) return;
    
    // Calculate UTC-based hue rotation (360° every 2 seconds)
    const utcTime = Date.now() / 1000;
    const cyclePosition = (utcTime % 2) / 2; // 0-1 over 2 seconds
    const hueRotation = cyclePosition * 360; // 0-360 degrees
    
    if(this.$playAnimOverlay) {
      this.$playAnimOverlay.style.filter = `hue-rotate(${hueRotation}deg)`;
    }
    
    // Apply same hue rotation to fullscreen clone if it exists
    if(this.fullscreenOverlay) {
      const clonedFrame = this.fullscreenOverlay.querySelector('.frame');
      const clonedAnimOverlay = clonedFrame?.querySelector('.play-animation-overlay');
      if(clonedAnimOverlay) {
        clonedAnimOverlay.style.setProperty('filter', `hue-rotate(${hueRotation}deg)`, 'important');
      }
    }
    
    this._animationUpdateId = requestAnimationFrame(() => this.animateHue());
  }

  // Fullscreen functionality
  async toggleFullscreen(){
    // Detect iOS devices
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    if (isIOS) {
      // iOS fallback - create fullscreen overlay outside the container
      if (this.fullscreenOverlay) {
        console.log('🍎 iOS: Exiting fullscreen');
        // Remove the overlay
        this.fullscreenOverlay.remove();
        this.fullscreenOverlay = null;
        // Restore body scrolling
        document.body.classList.remove('ios-fullscreen-active');
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
        document.body.style.height = '';
        this.updateFullscreenIcon(false);
        
        // Cleanup cursor auto-hide for iOS fullscreen
        this.cleanupFullscreenCursorEvents();
      } else {
        console.log('🍎 iOS: Entering fullscreen');
        // Create fullscreen overlay attached to body
        this.fullscreenOverlay = document.createElement('div');
        this.fullscreenOverlay.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          z-index: 2147483647;
          background: #000;
          display: flex;
          align-items: center;
          justify-content: center;
        `;
        
        // Clone the current frame content
        const clonedFrame = this.$frame.cloneNode(true);
        clonedFrame.style.cssText = `
          position: relative;
          width: 100vw;
          height: 100vh;
          border: none;
          background: transparent;
          cursor: pointer;
        `;
        
        // Apply fullscreen-specific styles while preserving layout
        const style = document.createElement('style');
        style.textContent = `
          .frame {
            width: 100vw !important;
            height: 100vh !important;
            border-radius: 0 !important;
            background: #000 !important;
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
          }
          .frame img {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
            object-position: center !important;
            z-index: 1 !important;
          }
          .frame .img-overlay {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            width: auto !important;
            height: auto !important;
            object-fit: contain !important;
            object-position: center !important;
            z-index: 1 !important;
          }
          .frame .play-animation-overlay {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            max-width: 100vw !important;
            max-height: 100vh !important;
            width: auto !important;
            height: auto !important;
            mix-blend-mode: overlay !important;
            object-fit: contain !important;
            object-position: center !important;
            z-index: 2 !important;
          }
          .frame .play-overlay {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            width: 80px !important;
            height: 80px !important;
            z-index: 5 !important;
          }
          .frame .pause-overlay {
            position: absolute !important;
            top: 50% !important;
            left: 50% !important;
            transform: translate(-50%, -50%) !important;
            width: 80px !important;
            height: 80px !important;
            z-index: 5 !important;
          }
          .frame .fullscreen-overlay {
            position: absolute !important;
            bottom: calc(15% + 2px) !important;
            right: 20% !important;
            transform: translate(50%, 50%) !important;
            width: 60px !important;
            height: 60px !important;
            z-index: 10 !important;
            opacity: 1 !important;
            pointer-events: auto !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
          }
          /* Landscape orientation adjustments */
          @media screen and (orientation: landscape) {
            .frame .fullscreen-overlay {
              bottom: calc(10% + 2px) !important;
              right: 20% !important;
              transform: translate(50%, 50%) !important;
            }
            .frame .progress-bar {
              bottom: 10% !important;
              left: 10% !important;
              right: 20% !important;
            }
          }
          /* Extra wide screens in landscape */
          @media screen and (orientation: landscape) and (min-aspect-ratio: 16/9) {
            .frame .fullscreen-overlay {
              right: 25% !important;
              transform: translate(50%, 50%) !important;
            }
            .frame .progress-bar {
              right: 25% !important;
            }
          }
          .frame .fullscreen-overlay svg {
            width: 20px !important;
            height: 20px !important;
            filter: drop-shadow(0 0 4px rgba(255,255,255,0.6)) !important;
          }
          .frame .progress-bar {
            position: absolute !important;
            bottom: 15% !important;
            left: 10% !important;
            right: 20% !important;
            height: 4px !important;
            z-index: 10 !important;
            background: rgba(255,255,255,0.2) !important;
            border-radius: 2px !important;
            overflow: hidden !important;
            opacity: 1 !important;
            backdrop-filter: blur(2px) !important;
            -webkit-backdrop-filter: blur(2px) !important;
          }
          .frame .progress-bar.visible {
            opacity: 1 !important;
          }
          .frame .progress-fill {
            height: 100% !important;
            width: 0% !important;
            background: linear-gradient(90deg, 
              rgba(255,255,255,0.3) 0%, 
              rgba(255,255,255,0.5) 50%, 
              rgba(255,255,255,0.3) 100%) !important;
            border-radius: 2px !important;
            transition: width 0.1s ease-out !important;
            position: relative !important;
          }
          .frame .progress-indicator {
            position: absolute !important;
            top: 50% !important;
            right: 0 !important;
            transform: translate(50%, -50%) !important;
            width: 10px !important;
            height: 10px !important;
            background: rgba(255,255,255,0.9) !important;
            border: 1px solid rgba(255,255,255,0.6) !important;
            border-radius: 50% !important;
            box-shadow: 0 0 8px rgba(255,255,255,0.4) !important;
            transition: all 0.1s ease-out !important;
          }
          .frame .sr-only {
            display: none !important;
          }
        `;
        clonedFrame.appendChild(style);
        
        // Reattach event handlers to cloned elements
        const clonedPauseOverlay = clonedFrame.querySelector('.pause-overlay');
        const clonedFullscreenOverlay = clonedFrame.querySelector('.fullscreen-overlay');
        const clonedFrameElement = clonedFrame.querySelector('.frame') || clonedFrame;
        
        // Pause button functionality in fullscreen
        if(clonedPauseOverlay) {
          clonedPauseOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            this.$audio.pause();
          });
          
          // Add keyboard support for pause button (matching original)
          clonedPauseOverlay.addEventListener('keydown', (e) => {
            if(e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              this.$audio.pause();
            }
          });
        }
        
        // Fullscreen button functionality (exit fullscreen)
        if(clonedFullscreenOverlay) {
          clonedFullscreenOverlay.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleFullscreen();
          });
          
          // Add keyboard support for fullscreen button (matching original)
          clonedFullscreenOverlay.addEventListener('keydown', (e) => {
            if(e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              this.toggleFullscreen();
            }
          });
        }
        
        // Frame click to toggle play/pause in fullscreen
        if(clonedFrameElement) {
          const clonedToggle = () => this.$audio.paused ? this.$audio.play() : this.$audio.pause();
          
          clonedFrameElement.addEventListener('click', (e) => {
            // Only toggle if not clicking on controls, using same logic as original
            if(!e.target.closest('.pause-overlay, .fullscreen-overlay')) {
              const clonedPauseOverlay = clonedFrame.querySelector('.pause-overlay');
              if(this.$audio.paused || !clonedPauseOverlay?.classList.contains('visible')) {
                clonedToggle();
              }
            }
          });
          
          // Add hover/touch interaction for pause button in fullscreen (matching original behavior)
          ['mouseenter', 'mousemove', 'touchstart', 'touchmove'].forEach(event => {
            clonedFrameElement.addEventListener(event, () => {
              if(!this.$audio.paused && clonedPauseOverlay) {
                clonedPauseOverlay.classList.add('visible');
                clonedPauseOverlay.style.setProperty('opacity', '1', 'important');
                clonedPauseOverlay.style.setProperty('pointer-events', 'auto', 'important');
                
                // Auto-hide after delay (matching original behavior)
                clearTimeout(this._fullscreenPauseTimeout);
                this._fullscreenPauseTimeout = setTimeout(() => {
                  clonedPauseOverlay.classList.remove('visible');
                  clonedPauseOverlay.style.setProperty('opacity', '0', 'important');
                  clonedPauseOverlay.style.setProperty('pointer-events', 'none', 'important');
                }, 1000);
              }
            });
          });
          
          // Add keyboard support for iOS fullscreen (matching original)
          clonedFrameElement.addEventListener('keydown', (e) => {
            if(e.key === ' ' || e.key === 'Enter') {
              e.preventDefault();
              const clonedPauseOverlay = clonedFrame.querySelector('.pause-overlay');
              if(this.$audio.paused || !clonedPauseOverlay?.classList.contains('visible')) {
                clonedToggle();
              }
            }
          });
          
          ['mouseleave'].forEach(event => {
            clonedFrameElement.addEventListener(event, () => {
              if(clonedPauseOverlay) {
                clearTimeout(this._fullscreenPauseTimeout);
                this._fullscreenPauseTimeout = setTimeout(() => {
                  clonedPauseOverlay.classList.remove('visible');
                }, 500);
              }
            });
          });
        }
        
        this.fullscreenOverlay.appendChild(clonedFrame);
        document.body.appendChild(this.fullscreenOverlay);
        
        // Sync current state to the fullscreen clone
        const clonedPlayOverlay = clonedFrame.querySelector('.play-overlay');
        const clonedAnimOverlay = clonedFrame.querySelector('.play-animation-overlay');
        const clonedProgressBar = clonedFrame.querySelector('.progress-bar');
        const clonedFullscreenBtn = clonedFrame.querySelector('.fullscreen-overlay');
        
        if(this.$audio.paused) {
          // Audio is paused - show play button, hide pause button and animation overlay
          clonedPlayOverlay?.classList.remove('hidden');
          clonedPlayOverlay?.style.setProperty('opacity', '1', 'important');
          clonedPauseOverlay?.classList.remove('visible');
          clonedPauseOverlay?.style.setProperty('opacity', '0', 'important');
          clonedPauseOverlay?.style.setProperty('pointer-events', 'none', 'important');
          clonedAnimOverlay?.classList.remove('active');
          clonedProgressBar?.classList.remove('visible');
          // Ensure fullscreen button is visible in paused state
          clonedFullscreenBtn?.classList.add('visible');
          clonedFullscreenBtn?.style.setProperty('opacity', '1', 'important');
          clonedFullscreenBtn?.style.setProperty('pointer-events', 'auto', 'important');
        } else {
          // Audio is playing - hide play button, pause button hidden by default, show animation overlay
          clonedPlayOverlay?.classList.add('hidden');
          clonedPlayOverlay?.style.setProperty('opacity', '0', 'important');
          clonedPauseOverlay?.classList.remove('visible');
          clonedPauseOverlay?.style.setProperty('opacity', '0', 'important');
          clonedPauseOverlay?.style.setProperty('pointer-events', 'none', 'important');
          clonedAnimOverlay?.classList.add('active');
          clonedAnimOverlay?.style.setProperty('opacity', '0.6', 'important');
          clonedAnimOverlay?.style.setProperty('mix-blend-mode', 'overlay', 'important');
          clonedProgressBar?.classList.add('visible');
          clonedProgressBar?.style.setProperty('opacity', '1', 'important');
          clonedProgressBar?.style.setProperty('pointer-events', 'auto', 'important');
          
          // Sync current progress immediately
          if(this.$audio.duration && this.$audio.currentTime) {
            const currentProgressPercent = Math.min(100, Math.max(0, (this.$audio.currentTime / this.$audio.duration) * 100));
            const clonedProgressFill = clonedFrame.querySelector('.progress-fill');
            if(clonedProgressFill) {
              clonedProgressFill.style.setProperty('width', `${currentProgressPercent}%`, 'important');
            }
          }
          
          // Ensure fullscreen button is visible in playing state
          clonedFullscreenBtn?.classList.add('visible');
          clonedFullscreenBtn?.style.setProperty('opacity', '1', 'important');
          clonedFullscreenBtn?.style.setProperty('pointer-events', 'auto', 'important');
        }
        
        // Prevent body scrolling
        document.body.classList.add('ios-fullscreen-active');
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.width = '100%';
        document.body.style.height = '100%';
        this.updateFullscreenIcon(true);
        console.log('🍎 iOS: Fullscreen overlay created and attached to body');
        
        // Setup cursor auto-hide for iOS fullscreen
        this.setupFullscreenCursorEvents();
      }
      this.lastActivityTime = Date.now();
      return;
    }
    
    // Standard fullscreen API for other browsers
    try {
      if(!document.fullscreenElement) {
        // Enter fullscreen
        if(this.$frame.requestFullscreen) {
          await this.$frame.requestFullscreen();
        } else if(this.$frame.webkitRequestFullscreen) {
          await this.$frame.webkitRequestFullscreen(); // Safari
        } else if(this.$frame.msRequestFullscreen) {
          await this.$frame.msRequestFullscreen(); // IE/Edge
        }
        this.updateFullscreenIcon(true);
        
        // Setup cursor auto-hide for standard fullscreen
        this.setupFullscreenCursorEvents();
      } else {
        // Exit fullscreen
        if(document.exitFullscreen) {
          await document.exitFullscreen();
        } else if(document.webkitExitFullscreen) {
          await document.webkitExitFullscreen(); // Safari
        } else if(document.msExitFullscreen) {
          await document.msExitFullscreen(); // IE/Edge
        }
        this.updateFullscreenIcon(false);
        
        // Cleanup cursor auto-hide for standard fullscreen
        this.cleanupFullscreenCursorEvents();
      }
    } catch(e) {
      console.warn('Fullscreen not supported or denied:', e);
    }
  }

  async exitFullscreen(){
    // Detect iOS devices
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    
    if (isIOS) {
      // iOS fallback - remove fullscreen overlay if it exists
      if (this.fullscreenOverlay) {
        console.log('🍎 iOS: Exiting fullscreen (from progress end)');
        // Remove the overlay
        this.fullscreenOverlay.remove();
        this.fullscreenOverlay = null;
        // Restore body scrolling
        document.body.classList.remove('ios-fullscreen-active');
        document.body.style.overflow = '';
        document.body.style.position = '';
        document.body.style.width = '';
        document.body.style.height = '';
        this.updateFullscreenIcon(false);
        
        // Cleanup cursor auto-hide
        this.cleanupFullscreenCursorEvents();
      }
    } else {
      // Standard fullscreen API for other browsers
      try {
        if(document.fullscreenElement) {
          // Exit fullscreen
          if(document.exitFullscreen) {
            await document.exitFullscreen();
          } else if(document.webkitExitFullscreen) {
            await document.webkitExitFullscreen(); // Safari
          } else if(document.msExitFullscreen) {
            await document.msExitFullscreen(); // IE/Edge
          }
          this.updateFullscreenIcon(false);
        }
      } catch(e) {
        console.warn('Exit fullscreen not supported or denied:', e);
      }
    }
  }

  initCursorAutoHide(){
    // Initialize cursor auto-hide for fullscreen mode
    this.cursorHideTimeout = null;
    this.cursorVisible = true;
    
    // Bind mouse move handler for cursor show/hide
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleMouseLeave = this.handleMouseLeave.bind(this);
  }

  handleMouseMove(){
    if(!this.isInFullscreen()) return;
    
    // Show cursor
    this.showCursor();
    
    // Clear existing timeout
    if(this.cursorHideTimeout) {
      clearTimeout(this.cursorHideTimeout);
    }
    
    // Set new timeout to hide cursor after 2 seconds of inactivity
    this.cursorHideTimeout = setTimeout(() => {
      this.hideCursor();
    }, 2000);
  }

  handleMouseLeave(){
    if(!this.isInFullscreen()) return;
    this.hideCursor();
  }

  showCursor(){
    if(!this.cursorVisible) {
      this.cursorVisible = true;
      const targetElement = this.fullscreenOverlay || this.$frame;
      if(targetElement) {
        targetElement.style.cursor = 'default';
      }
    }
  }

  hideCursor(){
    if(this.cursorVisible) {
      this.cursorVisible = false;
      const targetElement = this.fullscreenOverlay || this.$frame;
      if(targetElement) {
        targetElement.style.cursor = 'none';
      }
    }
  }

  isInFullscreen(){
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement) ||
           !!this.fullscreenOverlay;
  }

  setupFullscreenCursorEvents(){
    // Add mouse event listeners for cursor auto-hide
    const targetElement = this.fullscreenOverlay || this.$frame;
    if(targetElement) {
      targetElement.addEventListener('mousemove', this.handleMouseMove);
      targetElement.addEventListener('mouseleave', this.handleMouseLeave);
    }
  }

  cleanupFullscreenCursorEvents(){
    // Remove mouse event listeners and show cursor
    this.showCursor();
    
    if(this.cursorHideTimeout) {
      clearTimeout(this.cursorHideTimeout);
      this.cursorHideTimeout = null;
    }
    
    const targetElement = this.fullscreenOverlay || this.$frame;
    if(targetElement) {
      targetElement.removeEventListener('mousemove', this.handleMouseMove);
      targetElement.removeEventListener('mouseleave', this.handleMouseLeave);
    }
  }

  updateFullscreenIcon(isFullscreen){
    if(!this.$fullscreenOverlay) return;
    
    const svg = this.$fullscreenOverlay.querySelector('svg');
    const path = svg?.querySelector('path');
    
    if(path) {
      if(isFullscreen) {
        // Show "compress" icon when in fullscreen - arrows pointing inward
        path.setAttribute('d', 'M9 6 L9 9 L6 9 M11 6 L11 9 L14 9 M9 14 L9 11 L6 11 M11 14 L11 11 L14 11');
        this.$fullscreenOverlay.setAttribute('aria-label', 'Exit fullscreen');
        const description = this.$fullscreenOverlay.querySelector('#fullscreen-description');
        if(description) description.textContent = 'Exit fullscreen mode';
      } else {
        // Show "expand" icon when not in fullscreen - arrows pointing outward
        path.setAttribute('d', 'M6 6 L6 9 L9 9 M14 6 L14 9 L11 9 M6 14 L6 11 L9 11 M14 14 L14 11 L11 11');
        this.$fullscreenOverlay.setAttribute('aria-label', 'Enter fullscreen');
        const description = this.$fullscreenOverlay.querySelector('#fullscreen-description');
        if(description) description.textContent = 'Enter fullscreen mode';
      }
    }
  }

  syncFullscreenState(){
    // Sync state with iOS fullscreen clone if it exists
    if(!this.fullscreenOverlay) return;
    
    const clonedFrame = this.fullscreenOverlay.querySelector('.frame');
    if(!clonedFrame) return;
    
    const clonedPlayOverlay = clonedFrame.querySelector('.play-overlay');
    const clonedAnimOverlay = clonedFrame.querySelector('.play-animation-overlay');
    const clonedProgressBar = clonedFrame.querySelector('.progress-bar');
    
    if(this.$audio.paused) {
      // Audio is paused - hide animation overlay
      clonedPlayOverlay?.classList.remove('hidden');
      clonedPlayOverlay?.style.setProperty('opacity', '1', 'important');
      clonedAnimOverlay?.classList.remove('active');
      clonedAnimOverlay?.style.setProperty('opacity', '0', 'important');
      clonedProgressBar?.classList.remove('visible');
    } else {
      // Audio is playing - show animation overlay with hue rotation
      clonedPlayOverlay?.classList.add('hidden');
      clonedPlayOverlay?.style.setProperty('opacity', '0', 'important');
      clonedAnimOverlay?.classList.add('active');
      clonedAnimOverlay?.style.setProperty('opacity', '0.6', 'important');
      clonedAnimOverlay?.style.setProperty('mix-blend-mode', 'overlay', 'important');
      clonedProgressBar?.classList.add('visible');
      clonedProgressBar?.style.setProperty('opacity', '1', 'important');
    }
  }

  // Debug overlay (real-time metrics)
  paint(){
    if(!this.debug) return;
    const [cur, actualUtc, target] = [this.$audio.currentTime, this.utc(), this.targetTime()];
    const drift = (cur - target) * 1000;
    
    const srcType = this.$audio.src.includes('.mp3') ? 'MP3' : 
                   this.$audio.src.includes('.m3u8') ? 'Native HLS' : 
                   this.$audio.currentSrc ? 'HLS.js' : 'Unknown';
    
    const timeToEnd = this.$audio.duration ? (this.$audio.duration - cur) : 0;
    const loopStatus = timeToEnd <= 0.1 ? '🔄 LOOPING' : timeToEnd <= 1 ? '⚠️ NEAR END' : '▶️ PLAYING';
    
    const syncStatus = Math.abs(drift) <= this.allowed ? '✅ IN SYNC' : 
                      Math.abs(drift) <= this.allowed * 2 ? '⚠️ MINOR DRIFT' : '❌ OUT OF SYNC';
    
    const rows = {
      '🎵 Source': srcType, '⏱️ Current': `${cur.toFixed(3)}s`, '🕐 Actual UTC': `${actualUtc.toFixed(3)}s`,
      '🎯 Target': `${target.toFixed(3)}s`, '📊 Drift': `${drift.toFixed(1)}ms`, 
      '🌐 System Lat': `${this.measuredLatency.toFixed(1)}ms`, '🎧 User Lat': `${this.audioLatency.toFixed(0)}ms`,
      '🔧 Total Comp': `${(this.measuredLatency + this.audioLatency).toFixed(1)}ms`, 
      '⚡ Seek Lag': `${(this.lag() * 1000).toFixed(0)}ms`, '🎯 Tolerance': `${this.allowed}ms`,
      '⏰ To End': `${timeToEnd.toFixed(3)}s`, '🔄 Loop Status': loopStatus, '📡 Sync Status': syncStatus,
      '🎮 State': this._looping ? '🔄 Transitioning' : '▶️ Normal'
    };
    
    this.$dbg.innerHTML = Object.entries(rows)
      .map(([k, v]) => `<tr><td class='k'>${k}</td><td class='v'>${v}</td></tr>`).join('');
  }
}

// Auto-register when module imported
!customElements.get('synced-audio') && customElements.define('synced-audio', SyncedAudio);
