// Delivery email bodies (LICENSE_OPERATIONS.md §12). Placeholders filled by the CLI.
import { groupKey } from './format.mjs';

export function emailBody({ name, lid, key, machineCode, updatesUntil, lang = 'en', updated = false, signature = 'Expertmotion Support' }) {
  const v = { name, lid, lid_short: lid.slice(0, 8), key_grouped: groupKey(key), machine_code: machineCode, updates_until: updatesUntil, operator_signature: signature };
  const fill = (t) => t.replace(/\{(\w+)\}/g, (_, k) => (k in v ? String(v[k]) : `{${k}}`));
  const en = `Subject: ${updated ? 'Your updated licence key' : 'Your Expertmotion licence key'} ({lid_short})

Hi {name},

Thank you for buying Expertmotion. Your licence key is attached as {lid}.emlicense and printed below.

How to activate (takes one minute):
1. Open Expertmotion.
2. The licence screen opens by itself (or choose Help > Licence).
3. Paste the key into the field (or drop the attached file onto it) and click "Activate".

Your key:
{key_grouped}

Licence details
- Licensed to: {name}
- Computer: Machine Code {machine_code}
- Updates included until: {updates_until}
- Moving to another computer: up to 3 times per 12 months. Open Help > Licence on the new computer, copy its Machine Code and reply to this email.

Keep this email. Your licence works offline and never expires for the versions released before {updates_until}.

If the key is not accepted, reply with the error code shown (EM-5xxx) and we will fix it within one working day.

{operator_signature}
`;
  const id = `Subjek: ${updated ? 'Kunci lisensi Expertmotion Anda yang diperbarui' : 'Kunci lisensi Expertmotion Anda'} ({lid_short})

Halo {name},

Terima kasih telah membeli Expertmotion. Kunci lisensi Anda terlampir sebagai {lid}.emlicense dan tercetak di bawah ini.

Cara mengaktifkan (sekitar satu menit):
1. Buka Expertmotion.
2. Layar lisensi terbuka sendiri (atau pilih Help > Licence).
3. Tempel kunci ke kolom yang tersedia (atau seret berkas terlampir ke kolom itu) lalu klik "Activate".

Kunci Anda:
{key_grouped}

Rincian lisensi
- Atas nama: {name}
- Komputer: Machine Code {machine_code}
- Pembaruan termasuk hingga: {updates_until}
- Pindah ke komputer lain: hingga 3 kali per 12 bulan. Buka Help > Licence di komputer baru, salin Machine Code-nya, dan balas email ini.

Simpan email ini. Lisensi Anda bekerja tanpa internet dan tidak pernah kedaluwarsa untuk versi yang dirilis sebelum {updates_until}.

Jika kunci tidak diterima, balas dengan kode kesalahan yang ditampilkan (EM-5xxx) dan kami perbaiki dalam satu hari kerja.

{operator_signature}
`;
  const parts = lang === 'id' ? [id, en] : [en, id];
  return fill(parts.join('\n----------------------------------------\n\n'));
}
