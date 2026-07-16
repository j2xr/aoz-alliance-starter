-- seed at_event_types with all known event types
insert into at_event_types (code, display_name, layout_version, title_aliases) values
  ('polar_invasion',       'Polar Invasion',       'v1', array['polar invasion', 'invasion polaire']),
  ('elite_wars',           'Elite Wars',           'v1', array['elite wars']),
  ('wasteland_showdown',   'Wasteland Showdown',   'v1', array['wasteland showdown']),
  ('battle_frenzy',        'Battle Frenzy',        'v1', array['battle frenzy']),
  ('void_war',             'Void War',             'v1', array['void war']),
  ('ironblood_battlefield','Ironblood Battlefield','v1', array['ironblood battlefield'])
on conflict (code) do update
  set display_name   = excluded.display_name,
      layout_version = excluded.layout_version,
      title_aliases  = excluded.title_aliases;
