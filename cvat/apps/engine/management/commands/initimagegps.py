# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import dataclasses

from django.core.management.base import BaseCommand
from PIL import Image as PILImage

from cvat.apps.engine.media_extractors import extract_gps_from_image
from cvat.apps.engine.models import DimensionType, Image, StorageChoice, Task, TaskMode
from cvat.apps.engine.utils import take_by

GPS_FIELDS = ["latitude", "longitude", "altitude", "direction"]


class Command(BaseCommand):
    help = (
        "Reads GPS coordinates from the EXIF data of the original images "
        "and stores them for the frames of the existing tasks"
    )

    def add_arguments(self, parser):
        parser.add_argument(
            "--task",
            dest="task_ids",
            type=int,
            action="append",
            default=[],
            help="Process only this task (can be repeated)",
        )
        parser.add_argument(
            "--force",
            action="store_true",
            help="Re-read GPS also for images that already have it",
        )
        parser.add_argument(
            "--include-cloud",
            action="store_true",
            help="Also process tasks with data in cloud storages (downloads every image)",
        )

    def handle(self, *args, task_ids: list[int], force: bool, include_cloud: bool, **options):
        tasks = Task.objects.filter(
            mode=TaskMode.ANNOTATION, dimension=DimensionType.DIM_2D, data__isnull=False
        ).select_related("data")

        if task_ids:
            tasks = tasks.filter(id__in=task_ids)
        if not include_cloud:
            tasks = tasks.exclude(data__storage=StorageChoice.CLOUD_STORAGE)

        batch_size = 500
        total_found = 0
        for db_task in tasks.order_by("id").iterator():
            db_data = db_task.data
            images = Image.objects.filter(data=db_data, is_placeholder=False)
            if not force:
                images = images.filter(latitude__isnull=True)

            found = 0
            failed = 0
            for db_images in take_by(images.order_by("frame").iterator(), batch_size):
                updated = []
                for db_image in db_images:
                    try:
                        with db_data.get_openable(db_image.path).open("rb") as f:
                            with PILImage.open(f) as img:
                                gps = extract_gps_from_image(img)
                    except Exception as e:
                        failed += 1
                        self.stderr.write(f"Task #{db_task.id}: can't read '{db_image.path}': {e}")
                        continue

                    if gps is None and not force:
                        continue

                    gps_fields = dataclasses.asdict(gps) if gps else {}
                    for field in GPS_FIELDS:
                        setattr(db_image, field, gps_fields.get(field))
                    updated.append(db_image)
                    found += gps is not None

                if updated:
                    Image.objects.bulk_update(updated, GPS_FIELDS)

                    # Placeholder frames (honeypots) copy the GPS info of their real frames
                    for db_image in updated:
                        Image.objects.filter(
                            data=db_data, is_placeholder=True, real_frame=db_image.frame
                        ).update(**{field: getattr(db_image, field) for field in GPS_FIELDS})

            total_found += found
            if found or failed:
                self.stdout.write(
                    f"Task #{db_task.id}: {found} images with GPS"
                    + (f", {failed} unreadable" if failed else "")
                )

        self.stdout.write(f"Done, {total_found} images with GPS found")
