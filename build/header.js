// Substituted at publish time with the satellite CDN origin plus the version
// prefix (e.g. https://satellite.fusestudio.net/blockly/a1b2c3d), so index.html
// can be served from the Laravel origin while assets load from the CDN.
// `make dist` sets it to "." for local use.
var ASSET_BASE = "__ASSET_BASE__";

var filepath = { media: ASSET_BASE + '/media', msg_ja: ASSET_BASE + "/msg/js/ja.js", msg_en: ASSET_BASE + "/msg/js/en.js", msg_ja_kids: ASSET_BASE + "/msg/js/ja_kids.js"};

(function(){
  var html = "";
  html += '<link rel="stylesheet" type="text/css" href="' + ASSET_BASE + '/css/style.css">';
  html += '<title>BlocklyDuino</title>';

  // Polyfill for Event.path (removed in Chrome 109+, needed by old Blockly)
  html += '<script>';
  html += 'if(!("path" in Event.prototype)){';
  html += '  Object.defineProperty(Event.prototype,"path",{get:function(){return this.composedPath();}});';
  html += '}';
  html += '</script>';

  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/blockly_compressed.js"></script>';
  // Disable Blockly audio preload (triggers autoplay policy errors), but allow playback on user interaction
  //
  // Only the preload is stubbed, not loadAudio_ — the Audio objects still get
  // built so click/delete play on interaction. That needs media-src on the
  // page's CSP to name the satellite origins, since the mp3s are cross-origin
  // now; see BlocklyCspHeaders in the Laravel app.
  // Fix flyout click handling for modern browsers (Event.path removal, SVG click targets)
  html += '<script>';
  html += 'Blockly.preloadAudio_=function(){};';
  html += 'var origShow = Blockly.Flyout.prototype.show;';
  html += 'Blockly.Flyout.prototype.show = function(xmlList) {';
  html += '  var flyout = this;';
  html += '  var canvas = flyout.workspace_.getCanvas();';
  html += '  var oldRects = canvas.querySelectorAll(".blocklyClickRect");';
  html += '  oldRects.forEach(function(r) { r.remove(); });';
  html += '  origShow.call(this, xmlList);';
  html += '  setTimeout(function() {';
  html += '    var canvas = flyout.workspace_.getCanvas();';
  html += '    var blocks = flyout.workspace_.getTopBlocks(false);';
  html += '    blocks.forEach(function(block) {';
  html += '      if (!block.isInFlyout) return;';
  html += '      var svg = block.getSvgRoot();';
  html += '      if (svg && !svg._bgRectAdded) {';
  html += '        svg._bgRectAdded = true;';
  html += '        var xy = block.getRelativeToSurfaceXY();';
  html += '        var hw = block.getHeightWidth();';
  html += '        var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");';
  html += '        rect.setAttribute("x", xy.x - 5);';
  html += '        rect.setAttribute("y", xy.y - 5);';
  html += '        rect.setAttribute("width", hw.width + 10);';
  html += '        rect.setAttribute("height", hw.height + 10);';
  html += '        rect.setAttribute("fill", "transparent");';
  html += '        rect.setAttribute("class", "blocklyClickRect");';
  html += '        rect.style.cursor = "pointer";';
  html += '        canvas.insertBefore(rect, svg.nextSibling);';
  html += '        Blockly.bindEvent_(rect, "mousedown", null, flyout.createBlockFunc_(block));';
  html += '      }';
  html += '    });';
  html += '  }, 50);';
  html += '};';
  html += '</script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/blocks_compressed.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/arduino_compressed.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/msg/js/en.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/Blob.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/spin.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/FileSaver.min.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/blockly_helper.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/jquery-2.1.3.min.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/materialize.min.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/jquery.xdomainajax.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/jquery.cookie.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/setCategoryCharacter.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/init.js"></script>';
  html += '<script type="text/javascript" src="' + ASSET_BASE + '/js/my_materialize.js"></script>';
  // Module, so it can import the flasher. Deferred by definition, which is why
  // init.js calls window.initArduinoTab() rather than this self-starting.
  html += '<script type="module" src="' + ASSET_BASE + '/js/arduino_tab.js"></script>';
  document.write(html);
})();
