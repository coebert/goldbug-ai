select cron.alter_job((select jobid from cron.job where jobname='aegis-market-open-alerts'), schedule => '*/10 * * * *');
select cron.alter_job((select jobid from cron.job where jobname='aegis-corporate-action-deadlines'), schedule => '7 * * * *');
select cron.alter_job((select jobid from cron.job where jobname='ai-gateway-health-15min'), schedule => '*/30 * * * *');
select cron.alter_job((select jobid from cron.job where jobname='aegis-live-reconcile-15min'), schedule => '*/15 6-22 * * 1-5');
select cron.alter_job((select jobid from cron.job where jobname='orphan-order-sweep'), schedule => '5,35 6-22 * * 1-5');
select cron.alter_job((select jobid from cron.job where jobname='setup-scan-hourly'), schedule => '20 7-21 * * 1-5');
select cron.alter_job((select jobid from cron.job where jobname='aegis-backfill-intraday-equity'), schedule => '25 6-22 * * 1-5');
select cron.alter_job((select jobid from cron.job where jobname='run-locks-ttl-sweep'), schedule => '*/5 * * * *');