(function () {
  var form = document.querySelector("form[data-avatar]");
  if (!form) return;
  var img = document.getElementById("avatar-preview");
  var fields = ["skin", "hair_style", "hair_color", "eyes", "glasses", "fav_color", "pet_type"];

  function update() {
    var data = new FormData(form);
    var params = new URLSearchParams();
    fields.forEach(function (f) {
      var v = data.get(f);
      if (v) params.set(f, v);
    });
    img.src = "/avatar.svg?" + params.toString();
  }

  function limit(name, max) {
    form.querySelectorAll('input[name="' + name + '"]').forEach(function (cb) {
      cb.addEventListener("change", function () {
        if (form.querySelectorAll('input[name="' + name + '"]:checked').length > max) cb.checked = false;
      });
    });
  }

  form.addEventListener("change", update);
  limit("interests", 5);
  limit("themes", 4);
  update();
})();
