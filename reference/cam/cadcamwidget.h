// This file is a part of "Candle" application (hjLabs.in fork).
// CAD/CAM workbench panel — UI for the shared cadcam core.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef CADCAMWIDGET_H
#define CADCAMWIDGET_H

#include <QWidget>
#include <QStringList>

#include "cadcam/entity.h"

class QComboBox;
class QDoubleSpinBox;
class QPlainTextEdit;
class QLabel;
class QCheckBox;
class QTimer;

// A dockable panel that imports/creates 2D geometry, runs a CAM operation from
// the shared cadcam core, emits safe G-code, and hands the program to the main
// window's existing visualizer/sender via the programGenerated() signal.
class CadCamWidget : public QWidget
{
    Q_OBJECT

public:
    explicit CadCamWidget(QWidget *parent = nullptr);

    // Per-panel zoom percentage (100 == 1.0x). Used by the dock title bar.
    int zoomPercent() const { return int(qRound(m_zoom * 100.0)); }

public slots:
    // Per-panel zoom controls, driven from the dock title bar.
    void zoomIn();
    void zoomOut();
    void zoomReset();

signals:
    // Emitted when "Generate G-code" produces a program (one string per line).
    void programGenerated(const QStringList &lines);
    void statusMessage(const QString &message);
    // Emitted whenever the panel zoom changes (percent, 100 == 1.0x).
    void zoomChanged(int percent);

private slots:
    void loadDxf();
    void loadDemo();
    void generate();
    void scheduleLivePreview();

private:
    // Per-panel zoom: scales this widget's subtree font via a widget stylesheet
    // font-size (overrides the app-wide QSS font-size for this panel only).
    double m_zoom = 1.0;
    void applyZoom();

    cadcam::Drawing m_drawing;
    QString m_source;

    QComboBox *m_operation = nullptr;
    QComboBox *m_zmode = nullptr;
    QDoubleSpinBox *m_toolDia = nullptr;
    QDoubleSpinBox *m_stepover = nullptr;
    QDoubleSpinBox *m_stepdown = nullptr;
    QDoubleSpinBox *m_cutDepth = nullptr;
    QDoubleSpinBox *m_safeZ = nullptr;
    QDoubleSpinBox *m_feedXY = nullptr;
    QDoubleSpinBox *m_feedZ = nullptr;
    QDoubleSpinBox *m_rpm = nullptr;
    QLabel *m_info = nullptr;
    QPlainTextEdit *m_preview = nullptr;
    QCheckBox *m_livePreview = nullptr;
    QTimer *m_liveTimer = nullptr;

    void updateInfo();
    void setDrawing(const cadcam::Drawing &drawing, const QString &source);
};

#endif // CADCAMWIDGET_H
