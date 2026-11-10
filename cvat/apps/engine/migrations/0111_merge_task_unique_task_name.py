from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("engine", "0107_task_unique_task_name"),
        ("engine", "0110_rename_task_consensus_replicas_initial_replicas"),
    ]

    operations = []
