// This file is a part of "Candle" application (hjLabs.in fork).
// PCB-making workbench panel — UI for the cadcam PCB CAM core.
// Copyright 2026 hjLabs.in / Hemang Joshi

#ifndef PCBWIDGET_H
#define PCBWIDGET_H

#include <QWidget>
#include <QStringList>

#include "cadcam/gerberimporter.h"
#include "cadcam/excellonimporter.h"

class QComboBox;
class QCheckBox;
class QDoubleSpinBox;
class QSpinBox;
class QPlainTextEdit;
class QLabel;
class QTimer;

// A dockable panel that imports a Gerber copper layer + an Excellon drill file,
// generates isolation-routing / drilling / board-cutout toolpaths from the
// shared cadcam PCB core, emits safe G-code, and hands the program to the main
// window's existing visualizer/sender via programGenerated().
class PcbWidget : public QWidget
{
    Q_OBJECT

public:
    explicit PcbWidget(QWidget *parent = nullptr);

    // Per-panel zoom percentage (100 == 1.0x). Used by the dock title bar.
    int zoomPercent() const { return int(qRound(m_zoom * 100.0)); }

public slots:
    // Per-panel zoom controls, driven from the dock title bar.
    void zoomIn();
    void zoomOut();
    void zoomReset();

signals:
    void programGenerated(const QStringList &lines);
    void statusMessage(const QString &message);
    // Emitted whenever the panel zoom changes (percent, 100 == 1.0x).
    void zoomChanged(int percent);

private slots:
    void loadGerber();
    void loadExcellon();
    void generate();
    void scheduleLivePreview();

private:
    cadcam::GerberData m_gerber;
    cadcam::ExcellonData m_drill;
    bool m_haveGerber = false;
    bool m_haveDrill = false;

    QLabel *m_gerberInfo = nullptr;
    QLabel *m_drillInfo = nullptr;

    QCheckBox *m_doIsolation = nullptr;
    QCheckBox *m_doDrill = nullptr;
    QCheckBox *m_doCutout = nullptr;

    QComboBox *m_zmode = nullptr;
    QDoubleSpinBox *m_toolDia = nullptr;
    QSpinBox *m_passes = nullptr;
    QDoubleSpinBox *m_stepover = nullptr;
    QDoubleSpinBox *m_safeZ = nullptr;
    QDoubleSpinBox *m_copperZ = nullptr;
    QDoubleSpinBox *m_drillZ = nullptr;
    QDoubleSpinBox *m_cutoutDepth = nullptr;
    QDoubleSpinBox *m_feedXY = nullptr;
    QDoubleSpinBox *m_feedZ = nullptr;
    QDoubleSpinBox *m_rpm = nullptr;

    QPlainTextEdit *m_preview = nullptr;
    QCheckBox *m_livePreview = nullptr;
    QTimer *m_liveTimer = nullptr;

    void updateInfo();
    void loadDemoData();

    // Per-panel zoom: scales this widget's subtree font via a widget stylesheet
    // font-size (overrides the app-wide QSS font-size for this panel only).
    double m_zoom = 1.0;
    void applyZoom();
};

#endif // PCBWIDGET_H
