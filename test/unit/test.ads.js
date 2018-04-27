import plugin from '../../src/plugin.js';

QUnit.module('Ads Object', {
  beforeEach: function() {
    this.player = {
      currentSrc: () => {},
      duration: () => {},
      on: () => {},
      one: () => {},
      ready: () => {},
      setTimeout: () => {}
    };
    plugin.call(this.player);
  }
}, function() {

  /*
   * Basic live detection
   */
  QUnit.only('isLive', function(assert) {
    this.player.duration = () => 5;
    assert.equal(this.player.ads.isLive(this.player), false);

    this.player.duration = () => Infinity;
    assert.equal(this.player.ads.isLive(this.player), true);
  });

  /*
   * `contentIsLive` setting overrides live detection
   */
  QUnit.only('isLive and contentIsLive', function(assert) {
    this.player.duration = () => 5;
    this.player.settings.contentIsLive = true;
    assert.equal(this.player.ads.isLive(this.player), true);

    this.player.duration = () => 5;
    this.player.settings.contentIsLive = false;
    assert.equal(this.player.ads.isLive(this.player), false);

    this.player.duration = () => Infinity;
    this.player.settings.contentIsLive = true;
    assert.equal(this.player.ads.isLive(this.player), true);

    this.player.duration = () => Infinity;
    this.player.settings.contentIsLive = false;
    assert.equal(this.player.ads.isLive(this.player), false);
  });
});
