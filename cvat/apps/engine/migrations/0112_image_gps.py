from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("engine", "0111_merge_task_unique_task_name"),
    ]

    operations = [
        migrations.AddField(
            model_name="image",
            name="latitude",
            field=models.FloatField(blank=True, default=None, null=True),
        ),
        migrations.AddField(
            model_name="image",
            name="longitude",
            field=models.FloatField(blank=True, default=None, null=True),
        ),
        migrations.AddField(
            model_name="image",
            name="altitude",
            field=models.FloatField(blank=True, default=None, null=True),
        ),
        migrations.AddField(
            model_name="image",
            name="direction",
            field=models.FloatField(blank=True, default=None, null=True),
        ),
    ]
