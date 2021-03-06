const sharedHooks = window.sharedModuleHooks();

const timerExists = function(env, id) {
  return env.clock.timers.hasOwnProperty(id);
};

// Stub mobile browsers to force cancelContentPlay to be used
const fakeVideojs = function() {
  this.videojs = sinon.stub(videojs, 'browser').get(() => {
    return {
      IS_ANDROID: true,
      IS_IOS: true
    };
  });
};

// Restore original videojs behavior
const restoreVideojs = function() {
  this.videojs.restore();
};

// Run custom hooks before sharedModuleHooks, as videojs must be
// modified before seting up the player and videojs-contrib-ads
QUnit.module('Cancel Content Play', {
  beforeEach: _.flow(fakeVideojs, sharedHooks.beforeEach),
  afterEach: _.flow(restoreVideojs, sharedHooks.afterEach)
});

QUnit.test('pauses to wait for prerolls when the plugin loads BEFORE play', function(assert) {
  var spy = sinon.spy(this.player, 'pause');

  this.player.paused = function() {
    return false;
  };

  this.player.trigger('adsready');
  this.player.trigger('play');
  this.clock.tick(1);
  this.player.trigger('play');
  this.clock.tick(1);

  assert.strictEqual(spy.callCount, 2, 'play attempts are paused');
});


QUnit.test('pauses to wait for prerolls when the plugin loads AFTER play', function(assert) {
  var pauseSpy = sinon.spy(this.player, 'pause');

  this.player.paused = function() {
    return false;
  };

  this.player.trigger('play');
  this.clock.tick(1);
  this.player.trigger('play');
  this.clock.tick(1);
  assert.equal(pauseSpy.callCount, 2, 'play attempts are paused');
});

QUnit.test('stops canceling play events when an ad is playing', function(assert) {
  var setTimeoutSpy = sinon.spy(window, 'setTimeout');
  var pauseSpy = sinon.spy(this.player, 'pause');

  // Throughout this test, we check both that the expected timeout is
  // populated on the `clock` _and_ that `setTimeout` has been called the
  // expected number of times.
  assert.notOk(this.player.ads._cancelledPlay, 'we have not canceled a play event');

  this.player.paused = () => {
    return false;
  }
  this.player.trigger('play');
  assert.strictEqual(setTimeoutSpy.callCount, 1, 'one timer was created (`_prerollTimeout`)');
  assert.ok(timerExists(this, this.player.ads._state._timeout), 'preroll timeout exists after play');
  assert.equal(this.player.ads._cancelledPlay, true);

  this.clock.tick(1);
  assert.equal(pauseSpy.callCount, 1);

  this.player.trigger('adsready');
  assert.ok(timerExists(this, this.player.ads._state._timeout), 'preroll timeout exists after adsready');

  this.player.ads.startLinearAdMode();
  assert.notOk(timerExists(this, this.player.ads._state._timeout), 'preroll timeout no longer exists');

  this.player.trigger('play');
  assert.equal(pauseSpy.callCount, 1, 'pause is not called while in an ad break');

  window.setTimeout.restore();
});

QUnit.test("cancelContentPlay doesn\'t block play in content playback", function(assert) {
  const pauseSpy = sinon.spy(this.player, 'pause');

  this.player.trigger('loadstart');
  this.player.trigger('adscanceled');
  this.player.paused = () => {
    return false;
  }
  this.player.trigger('play');
  assert.strictEqual(pauseSpy.callCount, 1, 'pause should have been called');
  assert.strictEqual(this.player.ads._cancelledPlay, true,
    'cancelContentPlay is called while resuming');

  // enters ContentPlayback
  this.player.trigger('playing');
  this.player.trigger('play');

  assert.strictEqual(pauseSpy.callCount, 1, 'pause should not have been called again');
  assert.notOk(this.player.ads._cancelledPlay, 'cancelContentPlay does nothing in content playback');
});

QUnit.test('content is resumed after ads if a user initiated play event is canceled', function(assert) {
  var playSpy = sinon.spy(this.player, 'play');
  var setTimeoutSpy = sinon.spy(window, 'setTimeout');
  var pauseSpy = sinon.spy(this.player, 'pause');

  this.player.paused = () => {
    return false;
  }

  this.player.trigger('play');
  this.player.trigger('adsready');

  assert.strictEqual(setTimeoutSpy.callCount, 1, 'one timer was created (`_prerollTimeout`)');
  assert.ok(timerExists(this, this.player.ads._state._timeout), 'preroll timeout exists');
  assert.ok(this.player.ads._cancelledPlay, true, 'play has been canceled');
  assert.ok(pauseSpy.callCount, 1, 'pause was called');

  this.player.ads.startLinearAdMode();
  this.player.ads.endLinearAdMode();
  assert.strictEqual(playSpy.callCount, 1, 'play should be called by the snapshot restore');

  this.player.trigger('play');
  assert.ok(pauseSpy.callCount, 1, 'pause was not called again');
});