var filepath = { media: 'media', msg_ja:"msg/js/ja.js", msg_en: "msg/js/en.js", msg_ja_kids: "msg/js/ja_kids.js"};

(function(){
  var html = "";
  html += '<link rel="stylesheet" type="text/css" href="css/style.css">';
  html += '<title>BlocklyDuino</title>';

  html += '<script type="text/javascript" src="js/aws-sdk-2.2.4.min.js"></script>';
  html += '<script type="text/javascript" src="js/s3.js"></script>';

  // Polyfill for Event.path (removed in Chrome 109+, needed by old Blockly)
  html += '<script>';
  html += 'if(!("path" in Event.prototype)){';
  html += '  Object.defineProperty(Event.prototype,"path",{get:function(){return this.composedPath();}});';
  html += '}';
  html += '</script>';

  html += '<script type="text/javascript" src="js/blockly_compressed.js"></script>';
  // Disable Blockly audio preload (triggers autoplay policy errors), but allow playback on user interaction
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
  html += '<script type="text/javascript" src="js/blocks_compressed.js"></script>';
  html += '<script type="text/javascript" src="js/arduino_compressed.js"></script>';
  html += '<script type="text/javascript" src="msg/js/en.js"></script>';
  html += '<script type="text/javascript" src="js/Blob.js"></script>';
  html += '<script type="text/javascript" src="js/spin.js"></script>';
  html += '<script type="text/javascript" src="js/FileSaver.min.js"></script>';
  html += '<script type="text/javascript" src="js/blockly_helper.js"></script>';
  html += '<script type="text/javascript" src="js/jquery-2.1.3.min.js"></script>';
  html += '<script type="text/javascript" src="js/materialize.min.js"></script>';
  html += '<script type="text/javascript" src="js/jquery.xdomainajax.js"></script>';
  html += '<script type="text/javascript" src="js/jquery.cookie.js"></script>';
  html += '<script type="text/javascript" src="js/setCategoryCharacter.js"></script>';
  html += '<script type="text/javascript" src="js/init.js"></script>';
  html += '<script type="text/javascript" src="js/my_materialize.js"></script>';
  html += '<script type="text/javascript" src="js/ZeroClipboard.js"></script>';
  document.write(html);
})();
