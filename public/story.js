// Narração da história pela voz do próprio aparelho (Web Speech API): sem custo de servidor.
(function () {
  var player = document.getElementById('player');
  if (!player || !('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined') return;
  var synth = window.speechSynthesis;
  var play = document.getElementById('tts-play');
  var stop = document.getElementById('tts-stop');
  var title = document.getElementById('story-title');
  var scenes = Array.prototype.slice.call(document.querySelectorAll('.story-scene'));
  var voice = null;
  var queue = [];
  var index = 0;
  var speaking = false;

  function pickVoice() {
    var voices = synth.getVoices();
    voice = voices.filter(function (v) { return /^pt[-_]BR/i.test(v.lang); })[0]
      || voices.filter(function (v) { return /^pt/i.test(v.lang); })[0] || null;
  }

  // Frases curtas: alguns navegadores cortam falas longas no meio.
  function sentences(text) {
    return text.split(/(?<=[.!?…])\s+/).filter(function (s) { return s.trim(); });
  }

  function mark(scene) {
    scenes.forEach(function (el, i) { el.classList.toggle('reading', i === scene); });
  }

  function reset() {
    speaking = false;
    synth.cancel();
    mark(-1);
    play.hidden = false;
    stop.hidden = true;
  }

  function speakNext() {
    if (!speaking) return;
    if (index >= queue.length) return reset();
    var item = queue[index];
    var utterance = new SpeechSynthesisUtterance(item.text);
    utterance.lang = 'pt-BR';
    if (voice) utterance.voice = voice;
    utterance.rate = 0.92;
    utterance.onend = function () { index += 1; speakNext(); };
    utterance.onerror = function () { index += 1; speakNext(); };
    if (item.first && item.scene >= 0) scenes[item.scene].scrollIntoView({ behavior: 'smooth', block: 'center' });
    mark(item.scene);
    synth.speak(utterance);
  }

  play.addEventListener('click', function () {
    synth.cancel();
    queue = [{ text: title.textContent, scene: -1 }];
    scenes.forEach(function (el, i) {
      sentences(el.querySelector('.scene-text').textContent).forEach(function (text, j) {
        queue.push({ text: text, scene: i, first: j === 0 });
      });
    });
    queue.push({ text: 'Fim.', scene: -1 });
    index = 0;
    speaking = true;
    play.hidden = true;
    stop.hidden = false;
    speakNext();
  });

  stop.addEventListener('click', reset);
  window.addEventListener('pagehide', function () { synth.cancel(); });
  pickVoice();
  if ('onvoiceschanged' in synth) synth.onvoiceschanged = pickVoice;
  player.hidden = false;
})();
