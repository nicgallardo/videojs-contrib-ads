/*
This main plugin file is responsible for the public API and enabling the features
that live in in separate files.
*/

import videojs from 'video.js';

import {version as adsVersion} from '../package.json';

import redispatch from './redispatch.js';
import initializeContentupdate from './contentupdate.js';
import adMacroReplacement from './macros.js';
import cueTextTracks from './cueTextTracks.js';
import initCancelContentPlay from './cancelContentPlay.js';
import playMiddlewareFeature from './playMiddleware.js';

import {BeforePreroll} from './states.js';

const { playMiddleware, isMiddlewareMediatorSupported } = playMiddlewareFeature;
const VIDEO_EVENTS = videojs.getTech('Html5').Events;

// default settings
const defaults = {
  // maximum amount of time in ms to wait to receive `adsready` from the ad
  // implementation after play has been requested. Ad implementations are
  // expected to load any dynamic libraries and make any requests to determine
  // ad policies for a video during this time.
  timeout: 5000,

  // maximum amount of time in ms to wait for the ad implementation to start
  // linear ad mode after `readyforpreroll` has fired. This is in addition to
  // the standard timeout.
  prerollTimeout: undefined,

  // maximum amount of time in ms to wait for the ad implementation to start
  // linear ad mode after `readyforpostroll` has fired.
  postrollTimeout: undefined,

  // when truthy, instructs the plugin to output additional information about
  // plugin state to the video.js log. On most devices, the video.js log is
  // the same as the developer console.
  debug: false,

  // set this to true when using ads that are part of the content video
  stitchedAds: false,

  // force content to be treated as live or not live
  // if not defined, the code will try to infer if content is live,
  // which can have limitations.
  contentIsLive: undefined
};

const contribAdsPlugin = function(options) {

  const player = this; // eslint-disable-line consistent-this

  const settings = videojs.mergeOptions(defaults, options);

  // prefix all video element events during ad playback
  // if the video element emits ad-related events directly,
  // plugins that aren't ad-aware will break. prefixing allows
  // plugins that wish to handle ad events to do so while
  // avoiding the complexity for common usage
  const videoEvents = VIDEO_EVENTS.concat([
    'firstplay',
    'loadedalldata',
    'playing'
  ]);

  // Set up redispatching of player events
  player.on(videoEvents, redispatch);

  // Set up features to block content playback while waiting for ads.
  // Play middleware is only supported on later versions of video.js
  // and on desktop currently(as the user-gesture requirement on mobile
  // will disallow calling play once play blocking is lifted)
  // The middleware must also be registered outside of the plugin,
  // to avoid a middleware factory being created for each player
  if (isMiddlewareMediatorSupported() && settings.debug) {
    // We log the debug message here as the plugin settings are available here
    videojs.log('ADS:', 'Play middleware has been registered with videojs');
  } else {
    // Register the cancelContentPlay feature on the player
    initCancelContentPlay(player, settings.debug);
  }

  // If we haven't seen a loadstart after 5 seconds, the plugin was not initialized
  // correctly.
  player.setTimeout(() => {
    if (!player.ads._hasThereBeenALoadStartDuringPlayerLife && player.src() !== '') {
      videojs.log.error('videojs-contrib-ads has not seen a loadstart event 5 seconds ' +
        'after being initialized, but a source is present. This indicates that ' +
        'videojs-contrib-ads was initialized too late. It must be initialized ' +
        'immediately after video.js in the same tick. As a result, some ads will not ' +
        'play and some media events will be incorrect. For more information, see ' +
        'https://github.com/videojs/videojs-contrib-ads#important-note-about-initialization');
    }
  }, 5000);

  // "vjs-has-started" should be present at the end of a video. This makes sure it's
  // always there.
  player.on('ended', function() {
    if (!player.hasClass('vjs-has-started')) {
      player.addClass('vjs-has-started');
    }
  });

  // video.js removes the vjs-waiting class on timeupdate. We want
  // to make sure this still happens during content restoration.
  player.on('contenttimeupdate', function() {
    player.removeClass('vjs-waiting');
  });

  // We now auto-play when an ad gets loaded if we're playing ads in the same video
  // element as the content.
  // The problem is that in IE11, we cannot play in addurationchange but in iOS8, we
  // cannot play from adcanplay.
  // This will prevent ad plugins from needing to do this themselves.
  player.on(['addurationchange', 'adcanplay'], function() {
    if (player.ads.snapshot && player.currentSrc() === player.ads.snapshot.currentSrc) {
      return;
    }

    // If an ad isn't playing, don't try to play an ad. This could result from prefixed
    // events when the player is blocked by a preroll check, but there is no preroll.
    if (!player.ads.inAdBreak()) {
      return;
    }

    player.play();
  });

  player.on('nopreroll', function() {
    player.ads.debug('Received nopreroll event');
    player.ads.nopreroll_ = true;
  });

  player.on('nopostroll', function() {
    player.ads.debug('Received nopostroll event');
    player.ads.nopostroll_ = true;
  });

  // Restart the cancelContentPlay process.
  player.on('playing', () => {
    player.ads._cancelledPlay = false;
    player.ads._pausedOnContentupdate = false;
  });

  // Keep track of whether a play event has happened
  player.on('play', () => {
    player.ads._playRequested = true;
  });

  player.one('loadstart', () => {
    player.ads._hasThereBeenALoadStartDuringPlayerLife = true;
  });

  player.on('loadeddata', () => {
    player.ads._hasThereBeenALoadedData = true;
  });

  player.on('loadedmetadata', () => {
    player.ads._hasThereBeenALoadedMetaData = true;
  });

  // Replace the plugin constructor with the ad namespace
  player.ads = {
    settings,
    disableNextSnapshotRestore: false,

    // This is true if we have finished actual content playback but haven't
    // dealt with postrolls and officially ended yet
    _contentEnding: false,

    // This is set to true if the content has officially ended at least once.
    // After that, the user can seek backwards and replay content, but _contentHasEnded
    // remains true.
    _contentHasEnded: false,

    // Tracks if loadstart has happened yet for the initial source. It is not reset
    // on source changes because loadstart is the event that signals to the ad plugin
    // that the source has changed. Therefore, no special signaling is needed to know
    // that there has been one for subsequent sources.
    _hasThereBeenALoadStartDuringPlayerLife: false,

    // Tracks if loadeddata has happened yet for the current source.
    _hasThereBeenALoadedData: false,

    // Tracks if loadedmetadata has happened yet for the current source.
    _hasThereBeenALoadedMetaData: false,

    // Are we after startLinearAdMode and before endLinearAdMode?
    _inLinearAdMode: false,

    // Should we block calls to play on the content player?
    _shouldBlockPlay: false,
    // Tracks whether play has been requested for this source,
    // either by the play method or user interaction
    _playRequested: false,

    // This is an estimation of the current ad type being played
    // This is experimental currently. Do not rely on its presence or behavior!
    adType: null,

    VERSION: adsVersion,

    reset() {
      player.ads.disableNextSnapshotRestore = false;
      player.ads._contentEnding = false;
      player.ads._contentHasEnded = false;
      player.ads.snapshot = null;
      player.ads.adType = null;
      player.ads._hasThereBeenALoadedData = false;
      player.ads._hasThereBeenALoadedMetaData = false;
      player.ads._cancelledPlay = false;
      player.ads._shouldBlockPlay = false;
      player.ads.nopreroll_ = false;
      player.ads.nopostroll_ = false;
      player.ads._playRequested = false;
    },

    // Call this when an ad response has been received and there are
    // linear ads ready to be played.
    startLinearAdMode() {
      player.ads._state.startLinearAdMode();
    },

    // Call this when a linear ad pod has finished playing.
    endLinearAdMode() {
      player.ads._state.endLinearAdMode();
    },

    // Call this when an ad response has been received but there are no
    // linear ads to be played (i.e. no ads available, or overlays).
    // This has no effect if we are already in an ad break.  Always
    // use endLinearAdMode() to exit from linear ad-playback state.
    skipLinearAdMode() {
      player.ads._state.skipLinearAdMode();
    },

    stitchedAds(arg) {
      if (arg !== undefined) {
        this._stitchedAds = !!arg;
      }
      return this._stitchedAds;
    },

    // Returns whether the video element has been modified since the
    // snapshot was taken.
    // We test both src and currentSrc because changing the src attribute to a URL that
    // AdBlocker is intercepting doesn't update currentSrc.
    videoElementRecycled() {
      if (player.ads.shouldPlayContentBehindAd(player)) {
        return false;
      }

      if (!this.snapshot) {
        throw new Error(
          'You cannot use videoElementRecycled while there is no snapshot.');
      }

      const srcChanged = player.tech_.src() !== this.snapshot.src;
      const currentSrcChanged = player.currentSrc() !== this.snapshot.currentSrc;

      return srcChanged || currentSrcChanged;
    },

    // Returns a boolean indicating if given player is in live mode.
    // One reason for this: https://github.com/videojs/video.js/issues/3262
    // Also, some live content can have a duration.
    isLive(somePlayer) {
      if (typeof this.settings.contentIsLive === 'boolean') {
        return this.settings.contentIsLive;
      } else if (somePlayer.duration() === Infinity) {
        return true;
      } else if (videojs.browser.IOS_VERSION === '8' && somePlayer.duration() === 0) {
        return true;
      }
      return false;
    },

    // Return true if content playback should mute and continue during ad breaks.
    // This is only done during live streams on platforms where it's supported.
    // This improves speed and accuracy when returning from an ad break.
    shouldPlayContentBehindAd(somePlayer) {
      return !videojs.browser.IS_IOS &&
             !videojs.browser.IS_ANDROID &&
             somePlayer.duration() === Infinity;
    },

    // Returns true if player is in ad mode.
    //
    // Ad mode definition:
    // If content playback is blocked by the ad plugin.
    //
    // Examples of ad mode:
    //
    // * Waiting to find out if an ad is going to play while content would normally be
    //   playing.
    // * Waiting for an ad to start playing while content would normally be playing.
    // * An ad is playing (even if content is also playing)
    // * An ad has completed and content is about to resume, but content has not resumed
    //   yet.
    //
    // Examples of not ad mode:
    //
    // * Content playback has not been requested
    // * Content playback is paused
    // * An asynchronous ad request is ongoing while content is playing
    // * A non-linear ad is active
    isInAdMode() {
      return this._state.isAdState();
    },

    // Returns true if in ad mode but an ad break hasn't started yet.
    isWaitingForAdBreak() {
      return this._state.isWaitingForAdBreak();
    },

    // Returns true if content is resuming after an ad. This is part of ad mode.
    isContentResuming() {
      return this._state.isContentResuming();
    },

    // Deprecated because the name was misleading. Use inAdBreak instead.
    isAdPlaying() {
      return this._state.inAdBreak();
    },

    // Returns true if an ad break is ongoing. This is part of ad mode.
    // An ad break is the time between startLinearAdMode and endLinearAdMode.
    inAdBreak() {
      return this._state.inAdBreak();
    },

    /*
     * Remove the poster attribute from the video element tech, if present. When
     * reusing a video element for multiple videos, the poster image will briefly
     * reappear while the new source loads. Removing the attribute ahead of time
     * prevents the poster from showing up between videos.
     *
     * @param {Object} player The videojs player object
     */
    removeNativePoster() {
      const tech = player.$('.vjs-tech');

      if (tech) {
        tech.removeAttribute('poster');
      }
    },

    debug(...args) {
      if (this.settings.debug) {
        if (args.length === 1 && typeof args[0] === 'string') {
          videojs.log('ADS: ' + args[0]);
        } else {
          videojs.log('ADS:', ...args);
        }
      }
    }

  };

  player.ads._state = new BeforePreroll(player);
  player.ads._state.init(player);

  player.ads.stitchedAds(settings.stitchedAds);

  player.ads.cueTextTracks = cueTextTracks;
  player.ads.adMacroReplacement = adMacroReplacement.bind(player);

  // Start sending contentupdate and contentchanged events for this player
  initializeContentupdate(player);

  // Global contentchanged handler for resetting plugin state
  player.on('contentchanged', player.ads.reset);

  // A utility method for textTrackChangeHandler to define the conditions
  // when text tracks should be disabled.
  // Currently this includes:
  //  - on iOS with native text tracks, during an ad playing
  const shouldDisableTracks = function() {
    // If the platform matches iOS with native text tracks
    // and this occurs during ad playback, we should disable tracks again.
    // If shouldPlayContentBehindAd, no special handling is needed.
    return !player.ads.shouldPlayContentBehindAd(player) &&
            player.ads.inAdBreak() &&
            player.tech_.featuresNativeTextTracks &&
            videojs.browser.IS_IOS &&
            // older versions of video.js did not use an emulated textTrackList
            !Array.isArray(player.textTracks());
  };

  /*
   * iOS Safari will change caption mode to 'showing' if a user previously
   * turned captions on manually for that video source, so this TextTrackList
   * 'change' event handler will re-disable them in case that occurs during ad playback
   */
  const textTrackChangeHandler = function() {
    const textTrackList = player.textTracks();

    if (shouldDisableTracks()) {
      // We must double check all tracks
      for (let i = 0; i < textTrackList.length; i++) {
        const track = textTrackList[i];

        if (track.mode === 'showing') {
          track.mode = 'disabled';
        }
      }
    }
  };

  // Add the listener to the text track list
  player.ready(function() {
    player.textTracks().addEventListener('change', textTrackChangeHandler);
  });

  // Event handling for the current state.
  player.on([
    'play', 'playing', 'ended',
    'adsready', 'adscanceled', 'adskip', 'adserror', 'adtimeout',
    'ads-ad-started',
    'contentchanged', 'contentresumed', 'readyforpostroll',
    'nopreroll', 'nopostroll'], (e) => {
    player.ads._state.handleEvent(e.type);
  });

  // Clear timeouts and handlers when player is disposed
  player.on('dispose', function() {
    player.textTracks().removeEventListener('change', textTrackChangeHandler);
  });

};

const registerPlugin = videojs.registerPlugin || videojs.plugin;

// Register this plugin with videojs
registerPlugin('ads', contribAdsPlugin);

// Register the Play Middleware with video.js on script execution,
// to avoid a new playMiddleware factory being created on
// videojs for each player created.
if (isMiddlewareMediatorSupported()) {
  // Register the play middleware
  videojs.use('*', playMiddleware);
}

export default contribAdsPlugin;
