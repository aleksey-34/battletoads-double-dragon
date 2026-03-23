select id, slug, display_name, assigned_api_key_name
from tenants
where lower(slug) like '%mehmet%' or lower(display_name) like '%mehmet%';
