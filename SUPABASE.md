# KopiShop dengan Supabase

Supabase digunakan sebagai database PostgreSQL terkelola. API KopiShop tetap menangani autentikasi, izin per cabang, transaksi stok, audit log, pembuatan laporan, dan Socket.IO realtime. APK hanya terhubung ke API KopiShop; `service_role` dan password database tidak pernah dimasukkan ke APK.

## Menyiapkan project

1. Buat project baru di Supabase.
2. Buka **Connect** dan salin **Transaction pooler** connection string. Jangan gunakan publishable/anon key sebagai `DATABASE_URL`.
3. Salin `.env.example` menjadi `.env`, lalu isi `DATABASE_URL` dengan URL pooler tersebut dan tambahkan `sslmode=require`.
4. Isi `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, password seed, dan `CORS_ORIGINS` dengan nilai produksi.
5. Jalankan migrasi API:

```text
npm run db:deploy -w @kopi-pos/api
npm run db:seed -w @kopi-pos/api
```

Jika memakai Docker, isi variabel yang sama pada environment deployment API. Supabase hanya perlu menerima koneksi PostgreSQL; container API tetap dapat dijalankan di VPS, Railway, Render, atau layanan lain.

## Keamanan

Jangan menaruh `DATABASE_URL`, password database, `service_role`, atau JWT secret di `NEXT_PUBLIC_*`, kode Android, atau repository. Akses data dilakukan melalui API KopiShop yang sudah menerapkan autentikasi, role, branch scope, rate limit, dan audit.

## Catatan migrasi

Skema Prisma yang ada dipakai apa adanya sehingga seluruh fitur lama tetap kompatibel. File migrasi Supabase disalin dari migrasi Prisma awal di `supabase/migrations/`; jalankan hanya sekali pada project Supabase baru.
