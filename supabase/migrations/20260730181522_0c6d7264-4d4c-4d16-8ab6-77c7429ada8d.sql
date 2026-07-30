DO $$
DECLARE sid uuid;
BEGIN
  SELECT id INTO sid FROM vault.secrets WHERE name = 'CRON_SECRET' LIMIT 1;
  IF sid IS NULL THEN
    PERFORM vault.create_secret('5aca7f76eb13640d4eb31f00fe377cb2f30a8d88c8bded7ba343049f37d9dd50', 'CRON_SECRET', 'Shared secret used by scheduled jobs to call the app webhooks');
  ELSE
    PERFORM vault.update_secret(sid, '5aca7f76eb13640d4eb31f00fe377cb2f30a8d88c8bded7ba343049f37d9dd50');
  END IF;
END $$;