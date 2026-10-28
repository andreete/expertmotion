Buat video animasi motion graphics berbahasa Indonesia berjudul "Ekspor Nikel Indonesia 2026" untuk TikTok, lengkap dengan voiceover. Semua sudah saya tentukan di bawah, jadi jangan tanya balik dan jangan ubah angka, teks, atau naskah narasi. Visual hanya teks dan grafik animasi, tanpa gambar dan tanpa footage.

SPESIFIKASI
- Format vertikal 9:16, 1080x1920, 30 fps
- Durasi total mengikuti audio, maksimal 60 detik
- Latar solid #0f1a1f untuk seluruh video
- Font: Inter (via @remotion/google-fonts), hanya bobot 400 dan 500
- Semua animasi harus digerakkan oleh frame (useCurrentFrame, interpolate, spring, Sequence). Jangan pakai CSS transition, setTimeout, atau Math.random
- Warna: hijau #5DCAA5, merah-koral #F0997B, amber #EF9F27, abu #888780, teks redup #9fb3b8, teks utama #ffffff, pill CTA #1D9E75
- Format angka Indonesia di layar: koma sebagai desimal (contoh 25,96)

VOICEOVER (WAJIB DIBUAT DULU)
Gunakan kemampuan generate suara yang kamu punya untuk membuat voiceover, sebelum membuat animasi.
- Bahasa Indonesia (id-ID), suara natural, hangat, dan jelas. Nada percaya diri tapi tidak menggurui, tempo sedang cenderung cepat khas konten TikTok. Pilih sendiri suara terbaik yang tersedia
- Buat 9 klip audio TERPISAH, satu per kalimat, simpan di public/audio/ (v1.mp3 sampai v9.mp3). Tulisan di bawah sudah dalam bentuk lisan, bacakan persis seperti tertulis:
  v1: "Ekspor nikel Indonesia naik tujuh belas persen."
  v2: "Tapi volumenya justru turun tiga koma delapan persen."
  v3: "Januari sampai Agustus dua ribu dua puluh enam, nilainya hampir dua puluh enam miliar dolar."
  v4: "Dulu, sebelum hilirisasi, cuma tiga koma tiga miliar."
  v5: "Target tahun ini: empat puluh lima miliar."
  v6: "Artinya, empat bulan terakhir harus melesat."
  v7: "Sementara kuota bijih dipangkas."
  v8: "Pertanyaannya: ini benar-benar nilai tambah, atau sekadar harga naik?"
  v9: "Follow septianus angga W, untuk bedah isu global lainnya."
- Pada v9, "septianus angga W" dibaca sebagai nama akun: "septianus", "angga", lalu huruf "W"
- Setelah semua klip jadi, ukur durasi tiap klip (getAudioDurationInSeconds atau calculateMetadata) dan pakai angka itu untuk menentukan durasi adegan dan waktu kemunculan animasi
- Jeda antar klip dalam satu adegan: 0,3 detik. Jeda setelah klip terakhir sebuah adegan: 0,5 detik sebelum adegan berikutnya
- Durasi adegan = total durasi klip di adegan itu + jeda di atas
- Kalau total video lebih dari 60 detik, percepat suara sedikit, jangan potong narasi
- Jangan menambah musik latar
- Kalau pembuatan suara gagal, berhenti dan beri tahu saya. Jangan pakai timing karangan

SAFE ZONE TIKTOK
Padding konten: kiri 88px, kanan 160px, atas 120px. Bagian bawah 440px dikosongkan sepenuhnya (tertutup caption dan tombol TikTok). Semua teks dan grafik harus berada di dalam area aman ini. Teks sumber ditempel di atas area kosong bawah, 440px dari tepi bawah.

TRANSISI ANTAR ADEGAN
Setiap adegan masuk dengan fade-in 14 frame sambil naik dari 56px di bawah posisi akhir. Adegan sebelumnya fade-out di frame yang sama saat adegan berikutnya mulai (crossfade). Easing out cubic.

ADEGAN 1: HOOK (audio v1 dan v2)
- Label kecil abu #9fb3b8, 52px: "Ekspor nikel Indonesia, Jan–Agu 2026"
- Saat v1 mulai: angka besar hijau 240px bobot 500, counter dari "+0,0%" ke "+17,2%" selama 42 frame (easing out cubic, 1 desimal). Di bawahnya putih 72px: "nilai ekspor naik"
- Saat v2 mulai: muncul blok kedua (fade-in 15 frame, naik 56px): angka koral 176px bobot 500 "−3,8%", dan di bawahnya putih 72px "tapi volumenya turun"
- Sumber (44px, abu): "Sumber: Ditjen Minerba ESDM, 2026"

ADEGAN 2: ANGKA UTAMA (audio v3)
- Label abu 52px: "Januari–Agustus 2026"
- Saat v3 mulai: baris "US$" putih 80px di kiri, lalu counter hijau 248px bobot 500 dari "0,00" ke "25,96" selama 54 frame (2 desimal). Di bawahnya putih 88px: "miliar"
- Menjelang akhir v3 (sekitar 60% durasinya): fade-in "setara Rp472 triliun", abu 60px
- Sumber: "Sumber: ESDM via ANTARA, 28 Okt 2026"

ADEGAN 3: GRAFIK BATANG (audio v4 dan v5)
- Judul putih 64px bobot 500: "Nilai ekspor nikel (miliar US$)"
- Tiga batang vertikal sejajar di dasar, jarak antar batang 56px, lebar sama:
  1. "2017–18": nilai "3,3" di atas batang, tinggi akhir 60px, abu #888780
  2. "Jan–Agu 2026": nilai "25,96", tinggi akhir 460px, hijau #5DCAA5
  3. "Target 2026": nilai "45" (amber), tinggi akhir 800px, TANPA isi, hanya border putus-putus amber 8px
- Saat v4 mulai: batang 1 dan 2 tumbuh dari tinggi 0 selama 36 frame dengan easing bezier(0.2, 0.8, 0.2, 1)
- Saat v5 mulai: batang 3 (target) tumbuh dengan easing yang sama
- Nilai di atas batang putih 52px (angka target amber), label nama di bawah batang abu 52px
- Sumber: "Sumber: ESDM, 14 Okt 2026; ESDM via ANTARA"

ADEGAN 4: TEKANAN TARGET (audio v6 dan v7)
- Judul putih 80px bobot 500: "Empat bulan terakhir harus melesat"
- Saat v6 mulai, dua bar horizontal tumbuh dari lebar 0 selama 36 frame (easing sama seperti adegan 3):
  - Label putih 52px "Rata-rata Jan–Agu", bar hijau tinggi 56px lebar akhir 67% dari lebar area aman, teks abu 52px di bawahnya "±3,2 miliar per bulan"
  - Label putih "Dibutuhkan Sep–Des", bar amber tinggi 56px lebar akhir 100%, teks abu "±4,8 miliar per bulan"
- Saat v7 mulai: fade-in teks koral 64px "Sementara kuota bijih dipangkas."
- Sumber: "Hitungan sendiri dari target US$45 miliar"

ADEGAN 5: PERTANYAAN (audio v8)
- Satu teks putih 104px bobot 500, rata kiri, line-height 1,3, sekitar 280px dari atas area aman: "Ini benar-benar nilai tambah, atau sekadar harga naik?"
- Tanpa elemen lain, biarkan lapang

ADEGAN 6: CTA (audio v9)
- Teks abu 64px: "Bedah isu global lainnya"
- Saat v9 mulai: pill hijau #1D9E75 (border-radius penuh, padding 40px x 72px) berisi teks putih 76px bobot 500: "@septianusanggaw", muncul dengan spring ringan (sedikit overshoot)
- Di bawah pill, putih 80px bobot 500: "Follow sekarang"
- Biarkan adegan bertahan 1 detik setelah v9 selesai

KOMPOSISI
Buat satu komposisi utama dengan 6 Sequence. Pasang setiap klip audio dengan komponen Audio di dalam Sequence yang sesuai, mulai pada waktu yang dihitung dari durasi klip. Gunakan komponen terpisah per adegan agar mudah diedit. Setelah selesai, tampilkan preview lengkap dengan suara dan sebutkan durasi total videonya. Jangan export dulu.
